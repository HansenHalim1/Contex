"use client";

import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import mondaySdk from "monday-sdk-js";

type Ctx = { accountId: string; boardId: string; userId?: string; boardName?: string; accountRegion?: string };
type FileRow = { id: string; name: string; size_bytes: number; content_type: string };
type NoteMeta = { boardUuid: string; mondayBoardId: string; tenantId: string };
type Viewer = {
  id: string;
  name: string;
  email?: string | null;
  source: "monday" | "custom";
  status: "allowed" | "restricted";
  role: "admin" | "owner" | "member";
};
type UploadStatus = "uploading" | "processing" | "done" | "error";
type UploadProgress = { id: string; name: string; progress: number; status: UploadStatus };

type PlanName = "free" | "plus" | "premium" | "pro" | "enterprise";
type LimitKind = "boards" | "storage" | "viewers";

type UsageSnapshot = {
  plan: PlanName;
  boardsUsed: number;
  boardsCap: number | null;
  storageUsed: number;
  storageCap: number | null;
  viewersUsed: number;
  viewersCap: number | null;
};

type BoardSummary = {
  boardUuid: string;
  mondayBoardId: string;
  name: string | null;
  createdAt: string | null;
};

function normalisePlanName(value: string | null | undefined): PlanName {
  if (!value) return "free";
  const lower = String(value).toLowerCase();
  switch (lower) {
    case "plus":
    case "premium":
    case "pro":
    case "enterprise":
      return lower;
    case "ultra":
      return "pro";
    default:
      return "free";
  }
}

function asLimitKind(value: unknown): LimitKind | undefined {
  if (value === "boards" || value === "storage" || value === "viewers") return value;
  return undefined;
}

const mnd = mondaySdk();
const publicClientId = process.env.NEXT_PUBLIC_MONDAY_CLIENT_ID;
const publicRedirectUri = process.env.NEXT_PUBLIC_MONDAY_REDIRECT_URI;
const mondayOAuthUrl =
  publicClientId && publicRedirectUri
    ? `https://auth.monday.com/oauth2/authorize?client_id=${encodeURIComponent(
        publicClientId
      )}&redirect_uri=${encodeURIComponent(publicRedirectUri)}&response_type=code`
    : "/connect";

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

export default function BoardView() {
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState("");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [files, setFiles] = useState<FileRow[]>([]);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [activeTab, setActiveTab] = useState<"notes" | "files">("notes");
  const [noteMeta, setNoteMeta] = useState<NoteMeta | null>(null);
  const noteMetaRef = useRef<NoteMeta | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState(false);
  const [q, setQ] = useState("");
  const [viewers, setViewers] = useState<Viewer[]>([]);
  const [viewerInput, setViewerInput] = useState("");
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [addingViewer, setAddingViewer] = useState(false);
  const [canManageViewers, setCanManageViewers] = useState(false);
  const [restricted, setRestricted] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState<UploadProgress[]>([]);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [upgradeState, setUpgradeState] = useState<{ visible: boolean; limit?: LimitKind; plan?: PlanName }>({
    visible: false
  });
  const [initialised, setInitialised] = useState(false);
  const [boardsUsingContext, setBoardsUsingContext] = useState<BoardSummary[]>([]);

  const saveTimer = useRef<NodeJS.Timeout | null>(null);
  const pendingHtml = useRef<string | null>(null);
  const ctxRef = useRef<Ctx | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const queryRef = useRef(q);
  const editorFocusedRef = useRef(false);
  const removeUploadLater = useCallback((id: string, delay = 2000) => {
    setTimeout(() => {
      setUploadingFiles((prev) => prev.filter((upload) => upload.id !== id));
    }, delay);
  }, []);

  const updateUpload = useCallback((id: string, updates: Partial<UploadProgress>, options?: { removeAfter?: number }) => {
    setUploadingFiles((prev) =>
      prev.map((upload) => (upload.id === id ? { ...upload, ...updates } : upload))
    );
    if (options?.removeAfter != null) {
      removeUploadLater(id, options.removeAfter);
    }
  }, [removeUploadLater]);

  const openUpgradeModal = useCallback(
    (details: { limit?: string | null; plan?: string | null }) => {
      const planName = normalisePlanName(details.plan ?? null);
      const limit = asLimitKind(details.limit);
      setUpgradeState({ visible: true, limit, plan: planName });
    },
    []
  );

  const closeUpgradeModal = useCallback(() => {
    setUpgradeState((prev) => ({ ...prev, visible: false }));
  }, []);

  const openBoardInMonday = useCallback((mondayBoardId: string) => {
    const numeric = Number(mondayBoardId);
    if (!Number.isNaN(numeric)) {
      try {
        void mnd.execute("openBoard", { boardId: numeric });
        return;
      } catch (error) {
        console.error("Failed to open board in monday", error);
      }
    }
    window.open(`https://app.monday.com/boards/${encodeURIComponent(mondayBoardId)}`, "_blank", "noopener,noreferrer");
  }, []);

  const handleUpgradeResponse = useCallback(
    async (res: Response) => {
      if (res.status !== 403) return false;
      let payload: any;
      try {
        payload = await res.clone().json();
      } catch {
        return false;
      }

      if (payload?.upgradeRequired) {
        openUpgradeModal({ limit: payload.limit, plan: payload.currentPlan });
        return true;
      }

      return false;
    },
    [openUpgradeModal]
  );

  const openBillingPage = useCallback(() => {
    const query = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : "";
    window.open(`/billing${query}`, "_blank", "noopener,noreferrer");
  }, [tenantId]);

  useEffect(() => {
    let cancelled = false;

    const initialize = async () => {
      try {
        const [contextRes, tokenRes] = await Promise.all([mnd.get("context"), mnd.get("sessionToken")]);
        if (cancelled) return;

        const data = contextRes?.data;
        const accountId =
          isRecord(data) && "account" in data && isRecord(data.account) && data.account?.id !== undefined
            ? String(data.account.id)
            : "";
        const boardId =
          isRecord(data) && "boardId" in data && data.boardId !== undefined
            ? String(data.boardId as string | number)
            : "";
        const userId =
          isRecord(data) && "user" in data && isRecord(data.user) && data.user?.id !== undefined
            ? String(data.user.id)
            : undefined;
        const accountRegion = (() => {
          if (isRecord(data) && "account" in data && isRecord(data.account)) {
            const regionValue = (data.account as Record<string, any>).region;
            if (typeof regionValue === "string" && regionValue.trim()) {
              return String(regionValue);
            }
          }
          return undefined;
        })();

        if (!accountId || !boardId) {
          console.error("Missing account or board id from monday context", contextRes?.data);
          setLoading(false);
          return;
        }

        const sessionToken = tokenRes?.data ? String(tokenRes.data) : null;
        if (!sessionToken) {
          setSessionError(true);
          setLoading(false);
        } else {
          setToken(sessionToken);
          setSessionError(false);
        }

        let boardName: string | undefined;
        let adminFlag = false;
        const numericBoardId = Number(boardId);
        if (!Number.isNaN(numericBoardId)) {
          try {
            const query = `
              query ($boardIds: [ID!]) {
                me { id is_admin }
                boards(ids: $boardIds) {
                  name
                  owners { id }
                }
              }
            `;
            const boardRes = await mnd.api(query, { variables: { boardIds: [numericBoardId] } });
            if (isRecord(boardRes) && isRecord(boardRes.data)) {
              const me = isRecord(boardRes.data.me) ? boardRes.data.me : null;
              if (me && typeof me.is_admin === "boolean") {
                adminFlag = me.is_admin;
              }

              if (Array.isArray(boardRes.data.boards)) {
                const first = boardRes.data.boards[0];
                if (isRecord(first) && typeof first.name === "string") {
                  boardName = first.name;
                }
              }
            }
          } catch (error) {
            console.error("Failed to fetch board metadata", error);
          }
        }
        setCanManageViewers(adminFlag);

        const c: Ctx = { accountId, boardId, userId, boardName, accountRegion };
        setCtx(c);
        ctxRef.current = c;
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to initialize monday context/session", error);
          setSessionError(true);
          setLoading(false);
        }
      }
    };

    initialize();

    const subscription = mnd.listen("sessionToken", (res: any) => {
      const newToken = res?.data ? String(res.data) : null;
      setToken(newToken);
      setSessionError(!newToken);
    });

    return () => {
      cancelled = true;
      if (typeof subscription === "function") subscription();
    };
  }, []);

  const requestSessionToken = useCallback(async () => {
    try {
      const res = await mnd.get("sessionToken");
      const newToken = res?.data ? String(res.data) : null;
      if (!newToken) {
        setSessionError(true);
        return null;
      }
      if (newToken !== token) {
        setToken(newToken);
      }
      setSessionError(false);
      return newToken;
    } catch (error) {
      console.error("Failed to refresh session token", error);
      setSessionError(true);
      return null;
    }
  }, [token]);

  const fetchWithAuth = useCallback(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const attempt = async (authToken: string) => {
        const headers = new Headers(init.headers as HeadersInit | undefined);
        headers.set("Authorization", `Bearer ${authToken}`);
        return fetch(input, { ...init, headers });
      };

      let activeToken = token || (await requestSessionToken());
      if (!activeToken) {
        setSessionError(true);
        throw new Error("Missing session token");
      }

      let response = await attempt(activeToken);
      if (response.status === 401) {
        const refreshed = await requestSessionToken();
        if (refreshed && refreshed !== activeToken) {
          response = await attempt(refreshed);
        }
      }

      if (response.status === 401) {
        setSessionError(true);
        throw new Error("Unauthorized");
      }

      setSessionError(false);
      return response;
    },
    [requestSessionToken, token]
  );

  const loadNotes = useCallback(
    async (c: Ctx) => {
      const params = new URLSearchParams({ boardId: c.boardId });
      const res = await fetchWithAuth(`/api/notes?${params.toString()}`, { cache: "no-store" });
      if (await handleUpgradeResponse(res)) return;
      if (!res.ok) throw new Error("Failed to load notes");
      const data = await res.json();
      setNotes(data.html || "");
      setSavedAt(data.updated_at || null);
      if (data.boardUuid && data.mondayBoardId && data.tenantId) {
        setNoteMeta((prev) => {
          if (
            prev &&
            prev.boardUuid === data.boardUuid &&
            prev.mondayBoardId === data.mondayBoardId &&
            prev.tenantId === data.tenantId
          ) {
            return prev;
          }
          return { boardUuid: data.boardUuid, mondayBoardId: data.mondayBoardId, tenantId: data.tenantId };
        });
        setTenantId(data.tenantId);
      }
      pendingHtml.current = null;
      const editor = editorRef.current;
      if (editor && typeof data.html === "string" && editor.innerHTML !== data.html) {
        editor.innerHTML = data.html;
      }
    },
    [fetchWithAuth]
  );

  const loadFiles = useCallback(
    async (c: Ctx, query: string) => {
      const params = new URLSearchParams({ boardId: c.boardId });
      if (query) params.set("q", query);
      const res = await fetchWithAuth(`/api/files/list?${params.toString()}`);
      if (await handleUpgradeResponse(res)) return;
      if (!res.ok) throw new Error("Failed to load files");
      const data = await res.json();
      setFiles(data.files || []);
    },
    [fetchWithAuth, handleUpgradeResponse]
  );

  const loadUsage = useCallback(
    async (c: Ctx) => {
      const params = new URLSearchParams({ boardId: c.boardId });
      const res = await fetchWithAuth(`/api/usage?${params.toString()}`);
      if (await handleUpgradeResponse(res)) return;
      if (!res.ok) throw new Error("Failed to load usage");
      const data = await res.json();
      const snapshot: UsageSnapshot = {
        plan: normalisePlanName(data.plan),
        boardsUsed: Number(data.boardsUsed) || 0,
        boardsCap: typeof data.boardsCap === "number" ? data.boardsCap : null,
        storageUsed: Number(data.storageUsed) || 0,
        storageCap: typeof data.storageCap === "number" ? data.storageCap : null,
        viewersUsed: Number(data.viewersUsed) || 0,
        viewersCap: typeof data.viewersCap === "number" ? data.viewersCap : null
      };
      setUsage(snapshot);
    },
    [fetchWithAuth, handleUpgradeResponse]
  );

  const loadViewers = useCallback(async (c: Ctx) => {
    const params = new URLSearchParams({ boardId: c.boardId });
    const res = await fetchWithAuth(`/api/viewers/list?${params.toString()}`);
    if (await handleUpgradeResponse(res)) {
      setViewerError("Upgrade required to view additional viewers.");
      return;
    }
    if (!res.ok) throw new Error("Failed to load viewers");
    const data = await res.json();
    if (Array.isArray(data.viewers)) {
      setViewers(
        data.viewers.map((viewer: any) => {
          const role = viewer?.role === "admin" || viewer?.role === "owner" ? viewer.role : "member";
          const status = viewer?.status === "restricted" ? "restricted" : "allowed";
          return {
            ...viewer,
            role,
            status: role !== "member" ? "allowed" : status
          } as Viewer;
        })
      );
    } else {
      setViewers([]);
    }
    setViewerError(null);
  }, [fetchWithAuth, handleUpgradeResponse]);

  const loadBoards = useCallback(
    async (c: Ctx) => {
      const params = new URLSearchParams({ boardId: c.boardId });
      if (c.accountRegion) params.set("region", c.accountRegion);
      const res = await fetchWithAuth(`/api/boards/list?${params.toString()}`);
      if (await handleUpgradeResponse(res)) return;
      if (!res.ok) throw new Error("Failed to load boards");
      const data = await res.json();
      if (Array.isArray(data.boards)) {
        const mapped: BoardSummary[] = data.boards
          .map((board: any) => ({
            boardUuid: String(board.boardUuid ?? board.id ?? ""),
            mondayBoardId: String(board.mondayBoardId ?? ""),
            name: typeof board.name === "string" && board.name.trim() ? board.name : null,
            createdAt: board.createdAt ?? null
          }))
          .filter((board: BoardSummary) => Boolean(board.mondayBoardId));

        setBoardsUsingContext(mapped);

        const currentBoard = mapped.find((board) => board.mondayBoardId === c.boardId && board.name);
        if (currentBoard?.name) {
          setCtx((prev) => {
            if (!prev || prev.boardId !== c.boardId) return prev;
            if (prev.boardName === currentBoard.name) return prev;
            const nextBoardName = currentBoard.name ?? undefined;
            const next = { ...prev, boardName: nextBoardName };
            ctxRef.current = next;
            return next;
          });
        }
      } else {
        setBoardsUsingContext([]);
      }
    },
    [fetchWithAuth, handleUpgradeResponse]
  );

  const loadBoardData = useCallback(async () => {
    if (!ctx) return null;

    const resolveRes = await fetchWithAuth("/api/context/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boardId: ctx.boardId })
    });

    if (await handleUpgradeResponse(resolveRes)) {
      return null;
    }

    const resolvePayload = await resolveRes.json().catch(() => null);

    if (!resolveRes.ok) {
      const errorMessage = resolvePayload?.error;
      if (resolveRes.status === 403) {
        if (errorMessage === "viewer restricted") {
          setRestricted(true);
        } else {
          alert(errorMessage || "This board exceeds your plan limit. Please upgrade.");
        }
        return null;
      }

      throw new Error(`Resolve failed (${resolveRes.status})`);
    }

    setRestricted(false);
    if (resolvePayload?.tenantId) {
      setTenantId(resolvePayload.tenantId);
    }
    if (resolvePayload?.boardId && ctx.boardId) {
      const existingTenantId = noteMetaRef.current?.tenantId ?? "";
      const nextTenantId = resolvePayload.tenantId ?? existingTenantId;
      setNoteMeta((prev) => {
        if (
          prev &&
          prev.boardUuid === resolvePayload.boardId &&
          prev.mondayBoardId === ctx.boardId &&
          prev.tenantId === nextTenantId
        ) {
          return prev;
        }
        return {
          boardUuid: resolvePayload.boardId,
          mondayBoardId: ctx.boardId,
          tenantId: nextTenantId
        };
      });
    }
    const query = queryRef.current || "";

    const notesPromise = loadNotes(ctx);
    const othersPromise = Promise.allSettled([
      loadFiles(ctx, query),
      loadUsage(ctx),
      loadViewers(ctx),
      loadBoards(ctx)
    ]);

    return { notesPromise, othersPromise };
  }, [ctx, fetchWithAuth, handleUpgradeResponse, loadBoards, loadFiles, loadNotes, loadUsage, loadViewers]);

  useEffect(() => {
    if (!ctx || !token) return;

    let cancelled = false;

    const run = async () => {
      let bundle:
        | {
            notesPromise: Promise<void>;
            othersPromise: Promise<PromiseSettledResult<unknown>[]>;
          }
        | null = null;

      try {
        if (!initialised) setLoading(true);
        bundle = await loadBoardData();
        if (!bundle) {
          if (!cancelled) {
            if (!initialised) setInitialised(true);
            setLoading(false);
          }
          return;
        }
        await bundle.notesPromise;
      } catch (error) {
        if (!cancelled) console.error("Failed to load board data", error);
        if (!cancelled) {
          if (!initialised) setInitialised(true);
          setLoading(false);
        }
        return;
      }

      if (!cancelled) {
        if (!initialised) setInitialised(true);
        setLoading(false);
      }

      if (bundle) {
        const results = await bundle.othersPromise;
        if (cancelled) return;
        results.forEach((result) => {
          if (result.status === "rejected") {
            console.error("Failed to load auxiliary board data", result.reason);
          }
        });
      }
    };

    run();

    return () => {
      cancelled = true;
    };
  }, [ctx, token, loadBoardData, initialised]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (editorFocusedRef.current) return;
    const nextHtml = notes || "";
    if (editor.innerHTML !== nextHtml) {
      editor.innerHTML = nextHtml;
    }
  }, [notes]);

  useEffect(() => {
    ctxRef.current = ctx;
  }, [ctx]);

  useEffect(() => {
    noteMetaRef.current = noteMeta;
  }, [noteMeta]);

  useEffect(() => {
    queryRef.current = q;
  }, [q]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (tenantId) {
      (window as any).__CONTEXT_TENANT_ID__ = tenantId;
    }
  }, [tenantId]);

  const flushPendingSave = useCallback(
    async (options: { fireAndForget?: boolean } = {}) => {
      const { fireAndForget = false } = options;
      const currentCtx = ctxRef.current;
      if (!currentCtx) return;
      if (pendingHtml.current === null) return;

      const html = pendingHtml.current;
      pendingHtml.current = null;
      saveTimer.current = null;

      const scheduleRetry = () => {
        if (!saveTimer.current) {
          saveTimer.current = setTimeout(() => {
            void flushPendingSave();
          }, 2000);
        }
      };

      try {
        const payload = JSON.stringify({ boardId: currentCtx.boardId, html });
        const res = await fetchWithAuth("/api/notes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          keepalive: fireAndForget
        });
        if (await handleUpgradeResponse(res)) {
          pendingHtml.current = html;
          return;
        }
        if (res.ok) {
          const data = await res.json();
          setSavedAt(data.updated_at);
          if (data.boardUuid && data.mondayBoardId && data.tenantId) {
            setNoteMeta({ boardUuid: data.boardUuid, mondayBoardId: data.mondayBoardId, tenantId: data.tenantId });
            setTenantId(data.tenantId);
          }
        } else {
          pendingHtml.current = html;
          scheduleRetry();
        }
      } catch (error) {
        console.error("Failed to save notes", error);
        pendingHtml.current = html;
        scheduleRetry();
      }
    },
    [fetchWithAuth, handleUpgradeResponse]
  );

  function saveNotes(newHtml: string) {
    if (!ctxRef.current) return;
    pendingHtml.current = newHtml;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void flushPendingSave();
    }, 600);
  }

  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
      }
      void flushPendingSave();
    };
  }, [flushPendingSave]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        void flushPendingSave({ fireAndForget: true });
      }
    };

    const handleBeforeUnload = () => {
      flushPendingSave({ fireAndForget: true });
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [flushPendingSave]);

  const onUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    if (!ctx || !e.target.files?.length) return;
    if (restricted) {
      alert("You do not have permission to upload files to this board.");
      return;
    }

    const filesToUpload = Array.from(e.target.files);
    let abortRemaining = false;

    for (const file of filesToUpload) {
      if (abortRemaining) break;

      const uploadId = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setUploadingFiles((prev) => [
        ...prev,
        { id: uploadId, name: file.name, progress: 0, status: "uploading" }
      ]);

      try {
        const preRes = await fetchWithAuth("/api/files/sign-upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            boardId: ctx.boardId,
            filename: file.name,
            contentType: file.type || "application/octet-stream",
            sizeBytes: file.size
          })
        });

        if (await handleUpgradeResponse(preRes)) {
          abortRemaining = true;
          updateUpload(uploadId, { status: "error", progress: 100 }, { removeAfter: 4000 });
          continue;
        }

        if (!preRes.ok) {
          alert("Failed to prepare upload.");
          updateUpload(uploadId, { status: "error", progress: 100 }, { removeAfter: 4000 });
          continue;
        }

        const { uploadUrl, storagePath } = await preRes.json();

        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) {
              const progress = Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100)));
              updateUpload(uploadId, { progress });
            } else {
              updateUpload(uploadId, { progress: 75 });
            }
          };
          xhr.onerror = () => reject(new Error("Upload failed"));
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve();
            } else {
              reject(new Error(`Upload failed with status ${xhr.status}`));
            }
          };
          xhr.open("PUT", uploadUrl);
          xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
          xhr.send(file);
        });

        updateUpload(uploadId, { progress: 100, status: "processing" });

        const confRes = await fetchWithAuth("/api/files/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            boardId: ctx.boardId,
            name: file.name,
            sizeBytes: file.size,
            contentType: file.type || "application/octet-stream",
            storagePath
          })
        });

        if (await handleUpgradeResponse(confRes)) {
          abortRemaining = true;
          updateUpload(uploadId, { status: "error", progress: 100 }, { removeAfter: 4000 });
          continue;
        }

        if (!confRes.ok) {
          alert("Failed to finalize upload.");
          updateUpload(uploadId, { status: "error", progress: 100 }, { removeAfter: 4000 });
          continue;
        }

        updateUpload(uploadId, { status: "done", progress: 100 }, { removeAfter: 1500 });
      } catch (error) {
        console.error("Failed to upload file", error);
        alert("Upload failed.");
        updateUpload(uploadId, { status: "error", progress: 100 }, { removeAfter: 4000 });
      }
    }

    try {
      await loadFiles(ctx, q);
      await loadUsage(ctx);
    } catch (error) {
      console.error("Failed to refresh after upload", error);
    }

    if (e.target) e.target.value = "";
  };

  const openFile = async (file: FileRow) => {
    if (!ctx) return;
    if (restricted) {
      alert("You do not have permission to access files on this board.");
      return;
    }
    const params = new URLSearchParams({ boardId: ctx.boardId, fileId: file.id });
    try {
      const res = await fetchWithAuth(`/api/files/download?${params.toString()}`);
      if (await handleUpgradeResponse(res)) {
        return;
      }
      if (!res.ok) {
        alert("Unable to open file.");
        return;
      }
      const { url } = await res.json();
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      console.error("Failed to open file", error);
      alert("Unable to open file.");
    }
  };

  const deleteFile = useCallback(
    async (file: FileRow) => {
      if (!ctx) return;
      if (restricted) {
        alert("You do not have permission to delete files on this board.");
        return;
      }
      const confirmDelete = window.confirm(`Delete "${file.name}"?`);
      if (!confirmDelete) return;

      try {
        const res = await fetchWithAuth("/api/files/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ boardId: ctx.boardId, fileId: file.id })
        });

        if (await handleUpgradeResponse(res)) {
          return;
        }

        if (!res.ok) {
          const message = await res.text();
          alert(message || "Failed to delete file");
          return;
        }

        await loadFiles(ctx, q);
        await loadUsage(ctx);
      } catch (error) {
        console.error("Failed to delete file", error);
        alert("Failed to delete file");
      }
    },
    [ctx, fetchWithAuth, handleUpgradeResponse, loadFiles, loadUsage, q, restricted]
  );

  const addViewer = useCallback(async () => {
    if (!ctx || !viewerInput.trim()) {
      setViewerError("Enter a monday user ID.");
      return;
    }

    if (restricted) {
      setViewerError("You do not have permission to modify viewers on this board.");
      return;
    }

    try {
      setAddingViewer(true);
      setViewerError(null);
      const res = await fetchWithAuth("/api/viewers/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boardId: ctx.boardId, mondayUserId: viewerInput.trim() })
      });

      if (await handleUpgradeResponse(res)) {
        setViewerError("Upgrade required to add more viewers.");
        return;
      }

      if (!res.ok) {
        const errorText = await res.text();
        setViewerError(errorText || "Failed to add viewer");
        return;
      }

      if (ctx) {
        await loadViewers(ctx);
      }
      setViewerInput("");
    } catch (error) {
      console.error("Failed to add viewer", error);
      setViewerError("Failed to add viewer. Please try again.");
    } finally {
      setAddingViewer(false);
    }
  }, [ctx, fetchWithAuth, handleUpgradeResponse, loadViewers, restricted, viewerInput]);

  const updateViewerStatus = useCallback(
    async (viewerId: string, nextStatus: "allowed" | "restricted") => {
      if (!ctx) return;
      if (!canManageViewers) {
        alert("Only account admins can change viewer access.");
        return;
      }
      if (restricted) {
        alert("You do not have permission to change viewer access.");
        return;
      }
      try {
        const res = await fetchWithAuth("/api/viewers/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            boardId: ctx.boardId,
            mondayUserId: viewerId,
            status: nextStatus
          })
        });
        if (await handleUpgradeResponse(res)) {
          return;
        }
        if (!res.ok) {
          const details = await res.text();
          alert(details || "Failed to update viewer");
          return;
        }
        await loadViewers(ctx);
      } catch (error) {
        console.error("Failed to update viewer status", error);
        alert("Failed to update viewer status");
      }
    },
    [canManageViewers, ctx, fetchWithAuth, handleUpgradeResponse, loadViewers, restricted]
  );

  const uploadStatusLabel: Record<UploadStatus, string> = {
    uploading: "Uploading",
    processing: "Processing",
    done: "Completed",
    error: "Failed"
  };
  const uploadBarClass: Record<UploadStatus, string> = {
    uploading: "bg-[#0073EA]",
    processing: "bg-amber-500",
    done: "bg-green-500",
    error: "bg-red-500"
  };
  const uploadTextClass: Record<UploadStatus, string> = {
    uploading: "text-[#0073EA]",
    processing: "text-amber-600",
    done: "text-green-600",
    error: "text-red-600"
  };

  const allowedViewers = useMemo(() => viewers.filter((viewer) => viewer.status !== "restricted"), [viewers]);
  const restrictedViewers = useMemo(() => viewers.filter((viewer) => viewer.status === "restricted"), [viewers]);

  const pct = useMemo(() => {
    if (!usage || !usage.storageCap || usage.storageCap <= 0) return 0;
    return Math.min(100, Math.round((usage.storageUsed / usage.storageCap) * 100));
  }, [usage]);

  const upgradeButtonLabel = "View billing info";

  const currentBoardUuid = noteMeta?.boardUuid ?? noteMetaRef.current?.boardUuid ?? null;
  const boardLabel = ctx?.boardId ? (ctx.boardName ? `${ctx.boardName} (${ctx.boardId})` : ctx.boardId) : "Unknown board";
  const boardMismatch = noteMeta && ctx?.boardId && noteMeta.mondayBoardId !== ctx.boardId;

  if (loading) return <div className="max-w-6xl mx-auto p-8">Loading...</div>;

  if (restricted) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-16">
        <div className="rounded-xl border border-red-200 bg-red-50 p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 text-red-600">
            <i data-lucide="shield-off" className="h-6 w-6" />
          </div>
          <h1 className="text-xl font-semibold text-red-700 mb-2">Access Restricted</h1>
          <p className="text-sm text-red-600">
            Your monday.com user has been restricted from using Context on this board. Contact a board admin if
            you believe this is a mistake.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      {upgradeState.visible && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center">
          <div className="bg-white rounded-xl p-6 w-96 text-center shadow-xl">
            <h2 className="text-lg font-semibold mb-2">Billing Coming Soon</h2>
            <p className="text-gray-600 mb-1">You've reached the limit for your current plan.</p>
            <p className="text-sm text-gray-500 mb-4">Billing is not live yet, but you can review our plans and join the waitlist.</p>
            <div className="flex flex-col gap-2">
              <button
                id="upgrade-btn"
                className="bg-gradient-to-r from-[#0073EA] to-[#00CA72] text-white rounded-md px-4 py-2 text-sm font-medium"
                onClick={() => {
                  openBillingPage();
                  closeUpgradeModal();
                }}
              >
                {upgradeButtonLabel}
              </button>
              <button className="text-xs text-gray-500 underline" type="button" onClick={closeUpgradeModal}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="max-w-6xl mx-auto px-6 py-6">
        {sessionError && (
        <div className="fixed bottom-4 right-4 flex items-center gap-3 rounded-md bg-red-600 px-4 py-2 text-sm text-white shadow-lg">
          <span>Session expired - please reload the board.</span>
          <a
            href={mondayOAuthUrl}
            className="rounded bg-white/20 px-3 py-1 text-xs font-medium text-white hover:bg-white/30"
          >
            Authorize
          </a>
        </div>
        )}

      {/* Header */}
      <div className="flex items-center justify-between bg-white rounded-lg p-5 shadow-sm border border-gray-100">
        <div className="flex items-center gap-2">
          <i data-lucide="notebook" className="w-5 h-5 text-[#0073EA]" />
          <div>
            <h1 className="text-xl font-semibold text-[#1C1C1C]">Context - Board Knowledge Hub</h1>
            <p className="text-sm text-gray-500">
              Notes & files for board <span className="font-medium text-[#0073EA]">{boardLabel}</span>
            </p>
            {noteMeta && (
              <p className="text-xs text-gray-400">
                Stored note: mondayBoardId {noteMeta.mondayBoardId} - boardUuid {noteMeta.boardUuid} - tenantId {noteMeta.tenantId}
              </p>
            )}
            {boardMismatch && (
              <p className="text-xs text-red-500 mt-1">
                Warning: note record is tied to board {noteMeta?.mondayBoardId}; you are viewing board {ctx?.boardId}.
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 w-[520px] justify-end">
          {usage && (
            <div className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-600">
              Storage: {(usage.storageUsed / (1024 * 1024)).toFixed(2)} MB used
            </div>
          )}
          <a
            href={mondayOAuthUrl}
            className={`rounded-md px-4 py-2 text-sm shadow-sm flex items-center gap-1 hover:shadow-md ${
              sessionError ? "bg-red-600 text-white" : "bg-white text-gray-700 border border-gray-200"
            }`}
          >
            <i data-lucide="shield-check" className="w-4 h-4" /> Authorize
          </a>
          <button
            onClick={() => setActiveTab("notes")}
            className={`rounded-md px-4 py-2 text-sm shadow-sm flex items-center gap-1 hover:shadow-md ${
              activeTab === "notes" ? "bg-[#0073EA] text-white" : "bg-white text-gray-700 border border-gray-200"
            }`}
          >
            <i data-lucide="book-open" className="w-4 h-4" /> Notes
          </button>
          <button
            onClick={() => setActiveTab("files")}
            className={`rounded-md px-4 py-2 text-sm shadow-sm flex items-center gap-1 hover:shadow-md ${
              activeTab === "files" ? "bg-[#0073EA] text-white" : "bg-white text-gray-700 border border-gray-200"
            }`}
          >
            <i data-lucide="paperclip" className="w-4 h-4" /> Files
          </button>
          <button
            onClick={() => window.open("/pricing", "_blank")}
            className="rounded-md bg-gradient-to-r from-[#00CA72] to-[#0073EA] text-white px-4 py-2 text-sm shadow-sm flex items-center gap-1 hover:opacity-90 transition"
          >
            <i data-lucide="star" className="w-4 h-4" /> Upgrade
          </button>
      </div>
    </div>

      {/* Viewers */}
      <div className="mt-6 bg-white rounded-lg shadow-sm border border-gray-200">
        <div className="flex items-center justify-between border-b border-gray-100 p-4">
          <div className="flex items-center gap-2">
            <i data-lucide="users" className="w-4 h-4 text-[#0073EA]" />
            <h2 className="text-sm font-medium text-gray-700">Board Viewers</h2>
          </div>
          {canManageViewers ? (
            <div className="flex items-center gap-2">
              <input
                value={viewerInput}
                onChange={(e) => {
                  setViewerInput(e.target.value);
                  if (viewerError) setViewerError(null);
                }}
                placeholder="monday user id"
                className="w-44 rounded-md border border-gray-200 px-3 py-2 text-sm"
              />
              <button
                onClick={() => void addViewer()}
                disabled={addingViewer}
                className={`rounded-md px-4 py-2 text-sm text-white flex items-center gap-1 transition hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60 ${
                  addingViewer ? "bg-[#99C8FF]" : "bg-[#0073EA] hover:bg-[#005EB8]"
                }`}
              >
                <i data-lucide="user-plus" className="w-4 h-4" />
                {addingViewer ? "Adding..." : "Add viewer"}
              </button>
            </div>
          ) : (
            <div className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-500">Only account admins can manage viewer access</div>
          )}
        </div>
          <div className="p-4 text-sm">
            {viewerError && <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">{viewerError}</div>}
            {viewers.length === 0 ? (
              <div className="text-gray-400">No viewers yet. monday board subscribers appear here automatically.</div>
            ) : (
            <div className="space-y-4">
              {allowedViewers.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2 flex items-center gap-2">
                    <span className="h-1 w-1 rounded-full bg-green-400" />
                    Allowed ({allowedViewers.length})
                  </h3>
                  <ul className="space-y-2">
                    {allowedViewers.map((viewer) => (
                      <li
                        key={viewer.id}
                        className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between rounded-md border border-green-100 bg-green-50 px-3 py-2"
                      >
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-gray-700">{viewer.name}</span>
                            <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-green-600">
                              Allowed
                            </span>
                            {viewer.role === "admin" && (
                              <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-600">
                                Admin
                              </span>
                            )}
                            {viewer.role === "owner" && (
                              <span className="rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-purple-600">
                                Board Owner
                              </span>
                            )}
                          </div>
                          {viewer.email && <div className="text-xs text-gray-500">{viewer.email}</div>}
                          <div className="text-[10px] uppercase tracking-wide text-gray-400 mt-1">Source: {viewer.source}</div>
                        </div>
                        <div className="flex items-center gap-2 self-end sm:self-auto">
                          {canManageViewers && viewer.role === "member" && (
                            <button
                              onClick={() => void updateViewerStatus(viewer.id, "restricted")}
                              className="flex items-center gap-1 rounded-md border border-red-200 bg-white px-3 py-1 text-xs font-medium text-red-500 hover:bg-red-50"
                            >
                              <i data-lucide="user-x" className="h-3 w-3" />
                              Restrict
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {restrictedViewers.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2 flex items-center gap-2">
                    <span className="h-1 w-1 rounded-full bg-red-400" />
                    Restricted ({restrictedViewers.length})
                  </h3>
                  <ul className="space-y-2">
                    {restrictedViewers.map((viewer) => (
                      <li
                        key={viewer.id}
                        className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between rounded-md border border-red-200 bg-red-50 px-3 py-2"
                      >
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-gray-700">{viewer.name}</span>
                            <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-600">
                              Restricted
                            </span>
                            {viewer.role === "admin" && (
                              <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-600">
                                Admin
                              </span>
                            )}
                            {viewer.role === "owner" && (
                              <span className="rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-purple-600">
                                Board Owner
                              </span>
                            )}
                          </div>
                          {viewer.email && <div className="text-xs text-gray-500">{viewer.email}</div>}
                          <div className="text-[10px] uppercase tracking-wide text-gray-400 mt-1">Source: {viewer.source}</div>
                        </div>
                        <div className="flex items-center gap-2 self-end sm:self-auto">
                          {canManageViewers && (
                            <button
                              onClick={() => void updateViewerStatus(viewer.id, "allowed")}
                              className="flex items-center gap-1 rounded-md border border-green-200 bg-white px-3 py-1 text-xs font-medium text-green-600 hover:bg-green-50"
                            >
                              <i data-lucide="user-check" className="h-3 w-3" />
                              Allow
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
      </div>
    </div>

      {/* Boards using Context */}
      <div className="mt-6 bg-white rounded-lg shadow-sm border border-gray-200">
        <div className="flex items-center justify-between border-b border-gray-100 p-4">
          <div className="flex items-center gap-2">
            <i data-lucide="layout-grid" className="w-4 h-4 text-[#0073EA]" />
            <h2 className="text-sm font-medium text-gray-700">Boards using Context</h2>
          </div>
          <span className="text-xs text-gray-400">
            {boardsUsingContext.length} board{boardsUsingContext.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="p-4 text-sm">
          {boardsUsingContext.length === 0 ? (
            <div className="text-gray-400">No other boards have opened Context yet.</div>
          ) : (
            <ul className="space-y-2">
              {boardsUsingContext.map((board) => {
                const isCurrent = currentBoardUuid != null && board.boardUuid === currentBoardUuid;
                const label = board.name && board.name.trim() ? board.name : `Board ${board.mondayBoardId}`;
                return (
                  <li
                    key={board.boardUuid}
                    className={`flex items-center justify-between rounded-md border px-3 py-2 ${
                      isCurrent ? "border-[#0073EA] bg-[#E8F3FF]" : "border-gray-100 bg-white"
                    }`}
                  >
                    <div className="flex flex-col">
                      <span className="font-medium text-gray-700">{label}</span>
                      <span className="text-xs text-gray-400">ID: {board.mondayBoardId}</span>
                      {isCurrent && (
                        <span className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-[#0073EA]">
                          Current board
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => openBoardInMonday(board.mondayBoardId)}
                      className="text-xs text-[#0073EA] hover:underline"
                    >
                      Open in monday
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Notes */}
      <div className={`mt-6 bg-white rounded-lg shadow-sm border border-gray-200 ${activeTab === "notes" ? "" : "hidden"}`}>
        <div className="flex items-center justify-between border-b border-gray-100 p-4">
          <div className="flex items-center gap-2">
            <i data-lucide="edit-3" className="w-4 h-4 text-[#0073EA]" />
            <h2 className="text-sm font-medium text-gray-700">Board Notes</h2>
            <span className="text-xs text-gray-400">{savedAt ? `Saved ${new Date(savedAt).toLocaleString()}` : "Unsaved..."}</span>
          </div>
        </div>
        <div className="p-4">
          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            className="prose max-w-none min-h-[300px] rounded-md border border-gray-200 p-4 focus:outline-none"
            onFocus={() => {
              editorFocusedRef.current = true;
            }}
            onBlur={() => {
              editorFocusedRef.current = false;
              const editor = editorRef.current;
              if (editor && editor.innerHTML !== (notes || "")) {
                editor.innerHTML = notes || "";
              }
            }}
            onInput={(e) => {
              const html = (e.target as HTMLDivElement).innerHTML;
              setNotes(html);
              saveNotes(html);
            }}
          />
        </div>
      </div>

      {/* Files */}
      <div className={`mt-6 bg-white rounded-lg shadow-sm border border-gray-200 ${activeTab === "files" ? "" : "hidden"}`}>
          <div className="flex items-center justify-between border-b border-gray-100 p-4">
            <div className="flex items-center gap-2">
              <i data-lucide="folder" className="w-4 h-4 text-[#0073EA]" />
              <h2 className="text-sm font-medium text-gray-700">Board Files</h2>
            </div>
            <div className="flex items-center gap-2">
              <input id="file-input" type="file" multiple className="hidden" onChange={onUpload} />
              <label
                htmlFor="file-input"
                className="cursor-pointer rounded-md bg-[#0073EA] px-4 py-2 text-sm text-white flex items-center gap-1 transition hover:bg-[#005EB8] hover:shadow-md"
              >
                <i data-lucide="upload" className="w-4 h-4" />
                Upload
              </label>
              <input
                placeholder="Search files..."
                className="w-56 rounded-md border border-gray-200 px-3 py-2 text-sm"
                value={q}
                onChange={async (e) => {
                  const next = e.target.value;
                  setQ(next);
                  if (ctx) {
                    try {
                      await loadFiles(ctx, next);
                    } catch (error) {
                      console.error("Failed to filter files", error);
                    }
                  }
                }}
              />
            </div>
          </div>

          <div className="p-4 text-sm">
            {uploadingFiles.length > 0 && (
              <div className="mb-4 space-y-2">
                {uploadingFiles.map((upload) => (
                  <div key={upload.id} className="rounded-md border border-gray-200 bg-white p-3 shadow-sm">
                    <div className="flex items-center justify-between text-xs font-medium text-gray-600">
                      <span className="text-gray-700 truncate">{upload.name}</span>
                      <span className={uploadTextClass[upload.status]}>
                        {uploadStatusLabel[upload.status]}
                        {upload.status === "uploading" || upload.status === "processing"
                          ? ` • ${Math.min(upload.progress, 100)}%`
                          : ""}
                      </span>
                    </div>
                    <div className="mt-2 h-2 w-full rounded-full bg-gray-100">
                      <div
                        className={`h-2 rounded-full transition-all duration-200 ${uploadBarClass[upload.status]}`}
                        style={{ width: `${Math.max(0, Math.min(upload.progress, 100))}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {files.length === 0 ? (
              <div className="text-gray-400">No files uploaded yet.</div>
            ) : (
              <div className="flex flex-col gap-2">
                {files.map((f) => (
                  <div key={f.id} className="flex justify-between items-center border border-gray-100 rounded-md px-3 py-2 hover:bg-gray-50 hover:shadow-sm">
                    <div className="flex items-center gap-2">
                      <i data-lucide="file" className="w-4 h-4 text-[#0073EA]" />
                      <span className="text-gray-700">{f.name}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-gray-400">{(f.size_bytes / (1024 * 1024)).toFixed(2)} MB</span>
                      <button onClick={() => void openFile(f)} className="text-xs text-[#0073EA] flex items-center gap-1 hover:underline">
                        <i data-lucide="external-link" className="w-3 h-3" />
                        Open
                      </button>
                      <button
                        onClick={() => void deleteFile(f)}
                        className="text-xs text-red-500 flex items-center gap-1 hover:underline"
                      >
                        <i data-lucide="trash-2" className="w-3 h-3" />
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {usage && (
            <div className="border-t border-gray-100 p-4 text-xs text-gray-600">
              <div className="h-2 w-full rounded-full bg-gray-100">
                <div className="h-2 rounded-full bg-[#0073EA]" style={{ width: `${pct}%` }} />
              </div>
              <div className="mt-1 text-xs text-gray-400">
                {(usage.storageUsed / (1024 * 1024)).toFixed(2)} MB used
                {usage.storageCap
                  ? ` of ${(usage.storageCap / (1024 * 1024)).toFixed(0)} MB`
                  : " (unlimited)"}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}




