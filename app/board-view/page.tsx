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
  status: "viewer" | "restricted" | "editor";
  role: "admin" | "boardAdmin" | "member";
  isAdmin: boolean;
  isBoardAdmin: boolean;
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
const mondayOAuthUrl = "/api/monday/oauth/start";

type IconName =
  | "shield-off"
  | "shield-check"
  | "notebook"
  | "book-open"
  | "paperclip"
  | "star"
  | "users"
  | "user-plus"
  | "user-x"
  | "user-check"
  | "layout-grid"
  | "edit-3"
  | "folder"
  | "upload"
  | "file"
  | "external-link"
  | "trash-2";

const ICON_PATHS: Record<IconName, string[]> = {
  "shield-off": [
    "M5 6 L12 3 L19 6 V12 C19 16 16 19 12 21 C8 19 5 16 5 12 Z",
    "M4 4 L20 20"
  ],
  "shield-check": [
    "M5 6 L12 3 L19 6 V12 C19 16 16 19 12 21 C8 19 5 16 5 12 Z",
    "M9 12 L12 15 L17 10"
  ],
  notebook: [
    "M7 4 H17 C18.1 4 19 4.9 19 6 V18 C19 19.1 18.1 20 17 20 H7 C5.9 20 5 19.1 5 18 V6 C5 4.9 5.9 4 7 4 Z",
    "M10 4 V20"
  ],
  "book-open": [
    "M4 5 H11 C12.1 5 13 5.9 13 7 V19 C13 17.9 12.1 17 11 17 H4 Z",
    "M20 5 H13 C11.9 5 11 5.9 11 7 V19 C11 17.9 11.9 17 13 17 H20 Z"
  ],
  paperclip: [
    "M8 12 V16 C8 18.2 9.8 20 12 20 C14.2 20 16 18.2 16 16 V9 C16 7.3 14.7 6 13 6 C11.3 6 10 7.3 10 9 V15"
  ],
  star: [
    "M12 4 L14.4 9.3 L20 10.1 L16 13.9 L17 19.5 L12 16.8 L7 19.5 L8 13.9 L4 10.1 L9.6 9.3 Z"
  ],
  users: [
    "M9 11 C10.7 11 12 9.7 12 8 C12 6.3 10.7 5 9 5 C7.3 5 6 6.3 6 8 C6 9.7 7.3 11 9 11 Z",
    "M15 12 C17.2 12 19 13.8 19 16 V18 H5 V16 C5 13.8 6.8 12 9 12 Z",
    "M15 5 C16.7 5 18 6.3 18 8 C18 8.8 17.7 9.6 17.2 10.2"
  ],
  "user-plus": [
    "M12 12 C14.2 12 16 13.8 16 16 V18 H8 V16 C8 13.8 9.8 12 12 12 Z",
    "M12 5 C10.3 5 9 6.3 9 8 C9 9.7 10.3 11 12 11 C13.7 11 15 9.7 15 8 C15 6.3 13.7 5 12 5 Z",
    "M19 8 H21",
    "M20 7 V9"
  ],
  "user-x": [
    "M12 12 C14.2 12 16 13.8 16 16 V18 H8 V16 C8 13.8 9.8 12 12 12 Z",
    "M12 5 C10.3 5 9 6.3 9 8 C9 9.7 10.3 11 12 11 C13.7 11 15 9.7 15 8 C15 6.3 13.7 5 12 5 Z",
    "M18 7 L21 10",
    "M21 7 L18 10"
  ],
  "user-check": [
    "M12 12 C14.2 12 16 13.8 16 16 V18 H8 V16 C8 13.8 9.8 12 12 12 Z",
    "M12 5 C10.3 5 9 6.3 9 8 C9 9.7 10.3 11 12 11 C13.7 11 15 9.7 15 8 C15 6.3 13.7 5 12 5 Z",
    "M17.5 8.5 L19 10 L22 7"
  ],
  "layout-grid": [
    "M5 5 H11 V11 H5 Z",
    "M13 5 H19 V11 H13 Z",
    "M5 13 H11 V19 H5 Z",
    "M13 13 H19 V19 H13 Z"
  ],
  "edit-3": [
    "M4 13.5 V20 H10.5",
    "M17.1 7.1 L19.9 9.9 C20.3 10.3 20.3 10.9 19.9 11.3 L12.2 19 H4 V10.8 L11.7 3.1 C12.1 2.7 12.7 2.7 13.1 3.1 L16 6"
  ],
  folder: [
    "M3 7 H9 L11 9 H21 V18 C21 19.1 20.1 20 19 20 H5 C3.9 20 3 19.1 3 18 Z"
  ],
  upload: [
    "M12 5 L12 15",
    "M8 9 L12 5 L16 9",
    "M5 19 H19"
  ],
  file: [
    "M7 3 H14 L19 8 V19 C19 20.1 18.1 21 17 21 H7 C5.9 21 5 20.1 5 19 V5 C5 3.9 5.9 3 7 3 Z",
    "M14 3 V8 H19"
  ],
  "external-link": [
    "M9 15 L5 19 H19 V5 L15 9",
    "M9 5 H5 V9"
  ],
  "trash-2": [
    "M5 7 H19",
    "M10 11 V17",
    "M14 11 V17",
    "M7 7 L8 21 H16 L17 7",
    "M9 5 L10 3 H14 L15 5"
  ]
};

function Icon({ name, className }: { name: IconName; className?: string }) {
  const paths = ICON_PATHS[name];
  if (!paths) return null;
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths.map((d, idx) => (
        <path key={`${name}-${idx}`} d={d} />
      ))}
    </svg>
  );
}
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
  const [newViewerRole, setNewViewerRole] = useState<Viewer["status"]>("viewer");
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [addingViewer, setAddingViewer] = useState(false);
  const [canManageViewers, setCanManageViewers] = useState(false);
  const [viewerManageMode, setViewerManageMode] = useState<"none" | "admin" | "boardAdmin">("none");
  const [isAccountAdmin, setIsAccountAdmin] = useState(false);
  const [isBoardAdmin, setIsBoardAdmin] = useState(false);
  const [restricted, setRestricted] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState<UploadProgress[]>([]);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [boardAdminDeleteEnabled, setBoardAdminDeleteEnabled] = useState(false);
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
  const canEditRef = useRef(false);
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

  const currentViewerRole = useMemo<Viewer["status"]>(() => {
    if (restricted) return "restricted";
    const userId = ctx?.userId ? String(ctx.userId) : null;
    if (!userId) return "viewer";
    const match = viewers.find((viewer) => viewer.id === userId);
    return match?.status ?? "viewer";
  }, [ctx?.userId, restricted, viewers]);

  const canEdit = !restricted && currentViewerRole === "editor";

  useEffect(() => {
    canEditRef.current = canEdit;
  }, [canEdit]);

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
        let boardAdminFlag = false;
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
                if (isRecord(first)) {
                  if (typeof first.name === "string") {
                    boardName = first.name;
                  }
                  if (userId && Array.isArray(first.owners)) {
                    boardAdminFlag = first.owners.some((owner: any) => {
                      if (!owner) return false;
                      if (typeof owner === "string" || typeof owner === "number") {
                        return String(owner) === userId;
                      }
                      if (isRecord(owner) && owner.id !== undefined) {
                        return String(owner.id) === userId;
                      }
                      return false;
                    });
                  }
                }
              }
            }
          } catch (error) {
            console.error("Failed to fetch board metadata", error);
          }
        }
        setIsAccountAdmin(adminFlag);
        setIsBoardAdmin(boardAdminFlag);

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
          const isAdmin = Boolean(viewer?.isAdmin);
          const isBoardAdminFlag = Boolean(viewer?.isBoardAdmin ?? viewer?.isOwner);
          const derivedRole: Viewer["role"] = isAdmin ? "admin" : isBoardAdminFlag ? "boardAdmin" : "member";
          const rawStatus = typeof viewer?.status === "string" ? viewer.status : "viewer";
          const normalisedStatus: Viewer["status"] =
            rawStatus === "restricted" ? "restricted" : rawStatus === "editor" ? "editor" : "viewer";
          const appliedStatus: Viewer["status"] = derivedRole !== "member" ? "editor" : normalisedStatus;
          return {
            ...viewer,
            role: derivedRole,
            status: appliedStatus,
            isAdmin,
            isBoardAdmin: isBoardAdminFlag
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
    if ("boardAdminDeleteEnabled" in (resolvePayload ?? {})) {
      setBoardAdminDeleteEnabled(Boolean(resolvePayload?.boardAdminDeleteEnabled));
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
      if (!canEditRef.current) {
        pendingHtml.current = null;
        saveTimer.current = null;
        return;
      }
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
    if (!canEditRef.current) return;
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
      e.target.value = "";
      return;
    }
    if (!canEditRef.current) {
      alert("Only editors can upload files to this board.");
      e.target.value = "";
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
      if (!canEditRef.current) {
        alert("Only editors can delete files on this board.");
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

  const planAllowsBoardAdminDelete = useMemo(() => {
    const plan = usage?.plan;
    return plan === "pro" || plan === "enterprise";
  }, [usage?.plan]);
  const boardAdminPromotionAllowed = useMemo(() => {
    const plan = usage?.plan;
    if (!plan) return false;
    return (plan === "pro" || plan === "enterprise") && isBoardAdmin;
  }, [isBoardAdmin, usage?.plan]);
  const canDeleteBoardData = useMemo(() => {
    if (isAccountAdmin) return true;
    return isBoardAdmin && boardAdminDeleteEnabled && planAllowsBoardAdminDelete;
  }, [boardAdminDeleteEnabled, isAccountAdmin, isBoardAdmin, planAllowsBoardAdminDelete]);

  const addViewer = useCallback(async () => {
    if (!ctx || !viewerInput.trim()) {
      setViewerError("Enter a monday user ID.");
      return;
    }

    if (viewerManageMode !== "admin") {
      setViewerError("Only account admins can add viewers.");
      return;
    }

    if (restricted) {
      setViewerError("You do not have permission to modify viewers on this board.");
      return;
    }

    try {
      setAddingViewer(true);
      setViewerError(null);
      const canUseEditor = usage ? ["premium", "pro", "enterprise"].includes(usage.plan) : false;
      const desiredRole = canUseEditor ? newViewerRole : newViewerRole === "editor" ? "viewer" : newViewerRole;
      const res = await fetchWithAuth("/api/viewers/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boardId: ctx.boardId,
          mondayUserId: viewerInput.trim(),
          role: desiredRole
        })
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
      setNewViewerRole(canUseEditor ? desiredRole : "viewer");
    } catch (error) {
      console.error("Failed to add viewer", error);
      setViewerError("Failed to add viewer. Please try again.");
    } finally {
      setAddingViewer(false);
    }
  }, [
    ctx,
    fetchWithAuth,
    handleUpgradeResponse,
    loadViewers,
    newViewerRole,
    usage?.plan,
    restricted,
    viewerInput,
    viewerManageMode
  ]);

  const updateViewerRole = useCallback(
    async (viewerId: string, nextRole: Viewer["status"]) => {
      if (!ctx) return;
      if (viewerManageMode === "none") {
        alert("Only account admins can change viewer access.");
        return;
      }
      if (viewerManageMode === "boardAdmin") {
        if (!boardAdminPromotionAllowed) {
          alert("Only account admins can change viewer access.");
          return;
        }
        const allowedForBoardAdmin: Viewer["status"][] = ["viewer", "editor", "restricted"];
        if (!allowedForBoardAdmin.includes(nextRole)) {
          alert("Board admins can only assign viewer, editor, or restricted roles.");
          return;
        }
      }
      if (viewerManageMode === "admin" && !canManageViewers) {
        alert("Only account admins can change viewer access.");
        return;
      }
      if (restricted) {
        alert("You do not have permission to change viewer access.");
        return;
      }
      if (viewerId && viewers.find((viewer) => viewer.id === viewerId)?.status === nextRole) {
        return;
      }
      try {
        const res = await fetchWithAuth("/api/viewers/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            boardId: ctx.boardId,
            mondayUserId: viewerId,
            role: nextRole
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
    [canManageViewers, ctx, fetchWithAuth, handleUpgradeResponse, loadViewers, boardAdminPromotionAllowed, restricted, viewerManageMode, viewers]
  );

  const currentBoardUuid = noteMeta?.boardUuid ?? noteMetaRef.current?.boardUuid ?? null;
  const boardLabel = ctx?.boardId ? (ctx.boardName ? `${ctx.boardName} (${ctx.boardId})` : ctx.boardId) : "Unknown board";
  const boardMismatch = noteMeta && ctx?.boardId && noteMeta.mondayBoardId !== ctx.boardId;

  const toggleBoardAdminDelete = useCallback(async () => {
    if (!isAccountAdmin) return;
    try {
      const nextAllow = !boardAdminDeleteEnabled;
      const res = await fetchWithAuth("/api/settings/board-admin-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allow: nextAllow })
      });

      const payload = await res.json().catch(() => null);

      if (!res.ok) {
        const message = payload?.error || "Failed to update board admin delete permissions.";
        alert(message);
        return;
      }

      const updated = payload?.boardAdminDeleteEnabled;
      setBoardAdminDeleteEnabled(typeof updated === "boolean" ? updated : nextAllow);
    } catch (error) {
      console.error("Failed to toggle board admin delete permission", error);
      alert("Failed to update board admin delete permissions.");
    }
  }, [boardAdminDeleteEnabled, fetchWithAuth, isAccountAdmin]);

  const deleteBoardView = useCallback(
    async (board: BoardSummary) => {
      if (!ctx) return;
      if (!canDeleteBoardData) {
        alert("You do not have permission to delete board data.");
        return;
      }

      const label = board.name && board.name.trim() ? board.name : `Board ${board.mondayBoardId}`;
      const confirmed = window.confirm(
        `Delete all Context notes, files, and snapshots for "${label}"?\nThis action cannot be undone.`
      );
      if (!confirmed) return;

      try {
        const res = await fetchWithAuth("/api/boards/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            boardUuid: board.boardUuid,
            mondayBoardId: board.mondayBoardId
          })
        });

        if (await handleUpgradeResponse(res)) {
          return;
        }

        if (!res.ok) {
          const payload = await res.json().catch(() => null);
          const message = payload?.error || "Failed to delete board data";
          alert(message);
          return;
        }

        setBoardsUsingContext((prev) => prev.filter((entry) => entry.boardUuid !== board.boardUuid));

        if (board.boardUuid === currentBoardUuid) {
          setNotes("");
          setSavedAt(null);
          setFiles([]);
          setUsage(null);
          setViewers([]);
          setNoteMeta(null);
          noteMetaRef.current = null;
          alert("Board data deleted. Reload the board if you need to start fresh.");
        }

        await loadBoards(ctx);
      } catch (error) {
        console.error("Failed to delete board data", error);
        alert("Failed to delete board data.");
      }
    },
    [
      canDeleteBoardData,
      ctx,
      currentBoardUuid,
      fetchWithAuth,
      handleUpgradeResponse,
      loadBoards
    ]
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
  const planSupportsEditor = useMemo(() => {
    const plan = usage?.plan;
    if (!plan) return false;
    return plan === "premium" || plan === "pro" || plan === "enterprise";
  }, [usage]);
  const viewerRoleOptions = useMemo<Viewer["status"][]>(() => {
    if (viewerManageMode === "admin") {
      return planSupportsEditor ? ["viewer", "editor", "restricted"] : ["viewer", "restricted"];
    }
    if (viewerManageMode === "boardAdmin") {
      return planSupportsEditor ? ["viewer", "editor", "restricted"] : ["viewer", "restricted"];
    }
    return [];
  }, [planSupportsEditor, viewerManageMode]);
  const viewerRoleLabel: Record<Viewer["status"], string> = useMemo(
    () => ({ viewer: "Viewer", editor: "Editor", restricted: "Restricted" }),
    []
  );
  const viewerRowTone: Record<Viewer["status"], string> = useMemo(
    () => ({
      viewer: "border-green-100 bg-green-50",
      editor: "border-indigo-200 bg-indigo-50",
      restricted: "border-red-200 bg-red-50"
    }),
    []
  );
  const viewerBadgeTone: Record<Viewer["status"], string> = useMemo(
    () => ({
      viewer: "bg-green-100 text-green-600",
      editor: "bg-indigo-100 text-indigo-600",
      restricted: "bg-red-100 text-red-600"
    }),
    []
  );
  useEffect(() => {
    if (!planSupportsEditor && newViewerRole === "editor") {
      setNewViewerRole("viewer");
    }
  }, [planSupportsEditor, newViewerRole]);

  const allowedViewers = useMemo(() => viewers.filter((viewer) => viewer.status !== "restricted"), [viewers]);
  const restrictedViewers = useMemo(() => viewers.filter((viewer) => viewer.status === "restricted"), [viewers]);

  const pct = useMemo(() => {
    if (!usage || !usage.storageCap || usage.storageCap <= 0) return 0;
    return Math.min(100, Math.round((usage.storageUsed / usage.storageCap) * 100));
  }, [usage]);

  const storageUsesGigabytes = useMemo(() => {
    const plan = usage?.plan;
    return plan === "plus" || plan === "premium" || plan === "pro" || plan === "enterprise";
  }, [usage?.plan]);
  const storageUnitLabel = storageUsesGigabytes ? "GB" : "MB";
  const storageDivisor = storageUsesGigabytes ? 1024 * 1024 * 1024 : 1024 * 1024;
  const storageUsedDisplay = useMemo(() => {
    if (!usage) return null;
    return (usage.storageUsed / storageDivisor).toFixed(2);
  }, [storageDivisor, usage]);
  const storageCapDisplay = useMemo(() => {
    if (!usage || usage.storageCap == null) return null;
    const digits = storageUsesGigabytes ? 2 : 0;
    return (usage.storageCap / storageDivisor).toFixed(digits);
  }, [storageDivisor, storageUsesGigabytes, usage]);

  useEffect(() => {
    if (isAccountAdmin) {
      setViewerManageMode("admin");
      setCanManageViewers(true);
      return;
    }
    if (boardAdminPromotionAllowed) {
      setViewerManageMode("boardAdmin");
      setCanManageViewers(true);
      return;
    }
    setViewerManageMode("none");
    setCanManageViewers(false);
  }, [isAccountAdmin, boardAdminPromotionAllowed]);

  const upgradeButtonLabel = "View billing info";

  if (loading) return <div className="max-w-6xl mx-auto p-8">Loading...</div>;

  if (restricted) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-16">
        <div className="rounded-xl border border-red-200 bg-red-50 p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 text-red-600">
            <Icon name="shield-off" className="h-6 w-6" />
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
          <Icon name="notebook" className="w-5 h-5 text-[#0073EA]" />
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
            <Icon name="shield-check" className="w-4 h-4" /> Authorize
          </a>
          <button
            onClick={() => setActiveTab("notes")}
            className={`rounded-md px-4 py-2 text-sm shadow-sm flex items-center gap-1 hover:shadow-md ${
              activeTab === "notes" ? "bg-[#0073EA] text-white" : "bg-white text-gray-700 border border-gray-200"
            }`}
          >
            <Icon name="book-open" className="w-4 h-4" /> Notes
          </button>
          <button
            onClick={() => setActiveTab("files")}
            className={`rounded-md px-4 py-2 text-sm shadow-sm flex items-center gap-1 hover:shadow-md ${
              activeTab === "files" ? "bg-[#0073EA] text-white" : "bg-white text-gray-700 border border-gray-200"
            }`}
          >
            <Icon name="paperclip" className="w-4 h-4" /> Files
          </button>
          <button
            onClick={() => window.open("/pricing", "_blank")}
            className="rounded-md bg-gradient-to-r from-[#00CA72] to-[#0073EA] text-white px-4 py-2 text-sm shadow-sm flex items-center gap-1 hover:opacity-90 transition"
          >
            <Icon name="star" className="w-4 h-4" /> Upgrade
          </button>
      </div>
    </div>

      {/* Viewers */}
      <div className="mt-6 bg-white rounded-lg shadow-sm border border-gray-200">
        <div className="flex items-center justify-between border-b border-gray-100 p-4">
          <div className="flex items-center gap-2">
            <Icon name="users" className="w-4 h-4 text-[#0073EA]" />
            <h2 className="text-sm font-medium text-gray-700">Board Viewers</h2>
          </div>
          {viewerManageMode === "admin" ? (
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
              <select
                value={newViewerRole}
                onChange={(e) => setNewViewerRole(e.target.value as Viewer["status"])}
                className="rounded-md border border-gray-200 px-3 py-2 text-sm"
              >
                {viewerRoleOptions.map((role) => (
                  <option key={role} value={role}>
                    {viewerRoleLabel[role]}
                  </option>
                ))}
              </select>
              <button
                onClick={() => void addViewer()}
                disabled={addingViewer}
                className={`rounded-md px-4 py-2 text-sm text-white flex items-center gap-1 transition hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60 ${
                  addingViewer ? "bg-[#99C8FF]" : "bg-[#0073EA] hover:bg-[#005EB8]"
                }`}
              >
                <Icon name="user-plus" className="w-4 h-4" />
                {addingViewer ? "Adding..." : "Add viewer"}
              </button>
            </div>
          ) : viewerManageMode === "boardAdmin" ? (
            <div className="rounded-full bg-blue-50 px-3 py-1 text-xs text-blue-600">
              Board admins on Pro or Enterprise can adjust viewer roles (viewer / editor / restricted) below.
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
                        className={`flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between rounded-md border px-3 py-2 ${viewerRowTone[viewer.status]}`}
                      >
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-gray-700">{viewer.name}</span>
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${viewerBadgeTone[viewer.status]}`}
                            >
                              {viewerRoleLabel[viewer.status]}
                            </span>
                            {viewer.isAdmin && (
                              <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-600">
                                Admin
                              </span>
                            )}
                            {viewer.isBoardAdmin && (
                              <span className="rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-purple-600">
                                Board Admin
                              </span>
                            )}
                          </div>
                          {viewer.email && <div className="text-xs text-gray-500">{viewer.email}</div>}
                          <div className="text-[10px] uppercase tracking-wide text-gray-400 mt-1">Source: {viewer.source}</div>
                        </div>
                        <div className="flex items-center gap-2 self-end sm:self-auto">
                          {(viewerManageMode === "admin" || viewerManageMode === "boardAdmin") &&
                            !viewer.isAdmin &&
                            !viewer.isBoardAdmin && (
                            <select
                              value={viewer.status}
                              onChange={(e) => void updateViewerRole(viewer.id, e.target.value as Viewer["status"])}
                              className="rounded-md border border-gray-200 px-2 py-1 text-xs"
                            >
                              {viewerRoleOptions.map((option) => (
                                <option key={option} value={option}>
                                  {viewerRoleLabel[option]}
                                </option>
                              ))}
                            </select>
                          )}
                          {viewerManageMode === "boardAdmin" &&
                            boardAdminPromotionAllowed &&
                            !viewer.isAdmin &&
                            !viewer.isBoardAdmin && (
                              viewer.status === "editor" ? (
                                <span className="text-xs text-green-600">Already admin</span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => void updateViewerRole(viewer.id, "editor")}
                                  className="rounded-md bg-[#0073EA] px-3 py-1 text-xs font-medium text-white hover:bg-[#005EB8] hover:shadow-sm"
                                >
                                  Promote to Admin
                                </button>
                              )
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
                        className={`flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between rounded-md border px-3 py-2 ${viewerRowTone[viewer.status]}`}
                      >
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-gray-700">{viewer.name}</span>
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${viewerBadgeTone[viewer.status]}`}
                            >
                              {viewerRoleLabel[viewer.status]}
                            </span>
                            {viewer.isAdmin && (
                              <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-600">
                                Admin
                              </span>
                            )}
                            {viewer.isBoardAdmin && (
                              <span className="rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-purple-600">
                                Board Admin
                              </span>
                            )}
                          </div>
                          {viewer.email && <div className="text-xs text-gray-500">{viewer.email}</div>}
                          <div className="text-[10px] uppercase tracking-wide text-gray-400 mt-1">Source: {viewer.source}</div>
                        </div>
                        <div className="flex items-center gap-2 self-end sm:self-auto">
                          {(viewerManageMode === "admin" || viewerManageMode === "boardAdmin") &&
                            !viewer.isAdmin &&
                            !viewer.isBoardAdmin && (
                            <select
                              value={viewer.status}
                              onChange={(e) => void updateViewerRole(viewer.id, e.target.value as Viewer["status"])}
                              className="rounded-md border border-gray-200 px-2 py-1 text-xs"
                            >
                              {viewerRoleOptions.map((option) => (
                                <option key={option} value={option}>
                                  {viewerRoleLabel[option]}
                                </option>
                              ))}
                            </select>
                          )}
                          {viewerManageMode === "boardAdmin" &&
                            boardAdminPromotionAllowed &&
                            !viewer.isAdmin &&
                            !viewer.isBoardAdmin && (
                              viewer.status === "editor" ? (
                                <span className="text-xs text-green-600">Already admin</span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => void updateViewerRole(viewer.id, "editor")}
                                  className="rounded-md bg-[#0073EA] px-3 py-1 text-xs font-medium text-white hover:bg-[#005EB8] hover:shadow-sm"
                                >
                                  Promote to Admin
                                </button>
                              )
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
        <div className="flex flex-col gap-3 border-b border-gray-100 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Icon name="layout-grid" className="w-4 h-4 text-[#0073EA]" />
            <h2 className="text-sm font-medium text-gray-700">Boards using Context</h2>
          </div>
          <div className="flex flex-col gap-2 sm:items-end">
            <span className="text-xs text-gray-400">
              {boardsUsingContext.length} board{boardsUsingContext.length === 1 ? "" : "s"}
            </span>
            {isAccountAdmin && (
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2 text-xs text-gray-500">
                <button
                  type="button"
                  onClick={() => void toggleBoardAdminDelete()}
                  className={`w-fit rounded-md px-3 py-1 text-xs font-medium transition ${
                    boardAdminDeleteEnabled
                      ? "bg-red-100 text-red-600 hover:bg-red-200"
                      : "bg-green-100 text-green-700 hover:bg-green-200"
                  }`}
                >
                  {boardAdminDeleteEnabled
                    ? "Disallow board admins from deleting data"
                    : "Allow board admins to delete data"}
                </button>
                <span>{boardAdminDeleteEnabled ? "Enabled for board admins" : "Disabled for board admins"}</span>
              </div>
            )}
          </div>
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
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => openBoardInMonday(board.mondayBoardId)}
                        className="text-xs text-[#0073EA] hover:underline"
                      >
                        Open in monday
                      </button>
                      {canDeleteBoardData && (
                        <button
                          type="button"
                          onClick={() => void deleteBoardView(board)}
                          className="text-xs text-red-500 hover:underline"
                        >
                          Delete data
                        </button>
                      )}
                    </div>
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
            <Icon name="edit-3" className="w-4 h-4 text-[#0073EA]" />
            <h2 className="text-sm font-medium text-gray-700">Board Notes</h2>
            <span className="text-xs text-gray-400">{savedAt ? `Saved ${new Date(savedAt).toLocaleString()}` : "Unsaved..."}</span>
          </div>
        </div>
        {!canEdit && !restricted && (
          <div className="px-4 pt-3 text-xs text-gray-500">Only editors can modify notes. You're viewing a read-only copy.</div>
        )}
        <div className="p-4">
          <div
            ref={editorRef}
            contentEditable={canEdit}
            aria-readonly={!canEdit}
            suppressContentEditableWarning
            className={`prose max-w-none min-h-[300px] rounded-md border border-gray-200 p-4 focus:outline-none ${
              canEdit ? "" : "bg-gray-50 text-gray-500 cursor-not-allowed"
            }`}
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
              if (!canEditRef.current) {
                const editor = e.target as HTMLDivElement;
                editor.innerHTML = notes || "";
                return;
              }
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
              <Icon name="folder" className="w-4 h-4 text-[#0073EA]" />
              <h2 className="text-sm font-medium text-gray-700">Board Files</h2>
            </div>
            <div className="flex items-center gap-2">
              <input id="file-input" type="file" multiple className="hidden" onChange={onUpload} disabled={!canEdit} />
              <label
                htmlFor="file-input"
                aria-disabled={!canEdit}
                className={`rounded-md px-4 py-2 text-sm flex items-center gap-1 transition ${
                  canEdit
                    ? "cursor-pointer bg-[#0073EA] text-white hover:bg-[#005EB8] hover:shadow-md"
                    : "cursor-not-allowed bg-gray-200 text-gray-500"
                }`}
              >
                <Icon name="upload" className="w-4 h-4" />
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

          {usage && (
            <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 text-xs text-gray-600">
              <div className="h-2 w-full rounded-full bg-gray-100">
                <div className="h-2 rounded-full bg-[#0073EA]" style={{ width: `${pct}%` }} />
              </div>
              <div className="mt-1 text-xs text-gray-500">
                {storageUsedDisplay != null ? `${storageUsedDisplay} ${storageUnitLabel} used` : "Usage unavailable"}
                {usage.storageCap == null
                  ? " (unlimited)"
                  : ` of ${storageCapDisplay ?? "--"} ${storageUnitLabel}`}
              </div>
            </div>
          )}

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
                          ? ` - ${Math.min(upload.progress, 100)}%`
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
                      <Icon name="file" className="w-4 h-4 text-[#0073EA]" />
                      <span className="text-gray-700">{f.name}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-gray-400">{(f.size_bytes / (1024 * 1024)).toFixed(2)} MB</span>
                      <button onClick={() => void openFile(f)} className="text-xs text-[#0073EA] flex items-center gap-1 hover:underline">
                        <Icon name="external-link" className="w-3 h-3" />
                        Open
                      </button>
                      <button
                        onClick={() => void deleteFile(f)}
                        disabled={!canEdit}
                        className="text-xs text-red-500 flex items-center gap-1 hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:no-underline"
                      >
                        <Icon name="trash-2" className="w-3 h-3" />
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

