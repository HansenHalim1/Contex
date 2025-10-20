"use client";

import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import mondaySdk from "monday-sdk-js";

type Ctx = { accountId: string; boardId: string; userId?: string; boardName?: string };
type FileRow = { id: string; name: string; size_bytes: number; content_type: string };
type NoteMeta = { boardUuid: string; mondayBoardId: string; tenantId: string };

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
  const [usage, setUsage] = useState<{ boardsUsed: number; boardsCap: number; storageUsed: number; storageCap: number } | null>(null);
  const [activeTab, setActiveTab] = useState<"notes" | "files">("notes");
  const [noteMeta, setNoteMeta] = useState<NoteMeta | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState(false);
  const [q, setQ] = useState("");
  const [viewers, setViewers] = useState<string[]>([]);
  const [viewerInput, setViewerInput] = useState("");
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [addingViewer, setAddingViewer] = useState(false);

  const saveTimer = useRef<NodeJS.Timeout | null>(null);
  const pendingHtml = useRef<string | null>(null);
  const ctxRef = useRef<Ctx | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const queryRef = useRef(q);
  const editorFocusedRef = useRef(false);

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
        const numericBoardId = Number(boardId);
        if (!Number.isNaN(numericBoardId)) {
          try {
            const boardRes = await mnd.api(`query { boards (ids: [${numericBoardId}]) { name } }`);
            if (isRecord(boardRes) && isRecord(boardRes.data) && Array.isArray(boardRes.data.boards)) {
              const first = boardRes.data.boards[0];
              if (isRecord(first) && typeof first.name === "string") {
                boardName = first.name;
              }
            }
          } catch (error) {
            console.error("Failed to fetch board name", error);
          }
        }

        const c: Ctx = { accountId, boardId, userId, boardName };
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
      if (!res.ok) throw new Error("Failed to load notes");
      const data = await res.json();
      setNotes(data.html || "");
      setSavedAt(data.updated_at || null);
      if (data.boardUuid && data.mondayBoardId && data.tenantId) {
        setNoteMeta({ boardUuid: data.boardUuid, mondayBoardId: data.mondayBoardId, tenantId: data.tenantId });
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
      if (!res.ok) throw new Error("Failed to load files");
      const data = await res.json();
      setFiles(data.files || []);
    },
    [fetchWithAuth]
  );

  const loadUsage = useCallback(
    async (c: Ctx) => {
      const params = new URLSearchParams({ boardId: c.boardId });
      const res = await fetchWithAuth(`/api/usage?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load usage");
      const data = await res.json();
      setUsage(data);
    },
    [fetchWithAuth]
  );

  const loadViewers = useCallback(
    async (c: Ctx) => {
      const params = new URLSearchParams({ boardId: c.boardId });
      const res = await fetchWithAuth(`/api/viewers/list?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load viewers");
      const data = await res.json();
      setViewers(Array.isArray(data.viewers) ? data.viewers.map(String) : []);
    },
    [fetchWithAuth]
  );

  const loadBoardData = useCallback(async () => {
    if (!ctx) return;

    const resolveRes = await fetchWithAuth("/api/context/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boardId: ctx.boardId })
    });

    if (resolveRes.status === 403) {
      alert("This board exceeds your plan limit. Please upgrade.");
      return;
    }

    if (!resolveRes.ok) {
      throw new Error(`Resolve failed (${resolveRes.status})`);
    }

    const query = queryRef.current || "";
    await Promise.all([loadNotes(ctx), loadFiles(ctx, query), loadUsage(ctx), loadViewers(ctx)]);
  }, [ctx, fetchWithAuth, loadFiles, loadNotes, loadUsage, loadViewers]);

  useEffect(() => {
    if (!ctx || !token) return;

    let cancelled = false;

    const run = async () => {
      try {
        setLoading(true);
        await loadBoardData();
      } catch (error) {
        console.error("Failed to load board data", error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    run();

    return () => {
      cancelled = true;
    };
  }, [ctx, token, loadBoardData]);

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
    queryRef.current = q;
  }, [q]);

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
        if (res.ok) {
          const data = await res.json();
          setSavedAt(data.updated_at);
          if (data.boardUuid && data.mondayBoardId && data.tenantId) {
            setNoteMeta({ boardUuid: data.boardUuid, mondayBoardId: data.mondayBoardId, tenantId: data.tenantId });
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
    [fetchWithAuth]
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

    for (const file of Array.from(e.target.files)) {
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
        if (!preRes.ok) {
          if (preRes.status === 403) {
            alert("Storage cap reached. Please upgrade.");
          } else {
            alert("Failed to prepare upload.");
          }
          return;
        }

        const { uploadUrl, storagePath } = await preRes.json();

        const put = await fetch(uploadUrl, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type || "application/octet-stream" }
        });
        if (!put.ok) {
          alert("Upload failed.");
          return;
        }

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
        if (!confRes.ok) {
          alert("Confirm failed.");
          return;
        }
      } catch (error) {
        console.error("Failed to upload file", error);
        alert("Upload failed.");
        return;
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
    const params = new URLSearchParams({ boardId: ctx.boardId, fileId: file.id });
    try {
      const res = await fetchWithAuth(`/api/files/download?${params.toString()}`);
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

  const addViewer = useCallback(async () => {
    if (!ctx || !viewerInput.trim()) {
      setViewerError("Enter a monday user ID.");
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

      if (!res.ok) {
        const errorText = await res.text();
        setViewerError(errorText || "Failed to add viewer");
        return;
      }

      await loadViewers(ctx);
      setViewerInput("");
    } catch (error) {
      console.error("Failed to add viewer", error);
      setViewerError("Failed to add viewer. Please try again.");
    } finally {
      setAddingViewer(false);
    }
  }, [ctx, fetchWithAuth, loadViewers, viewerInput]);

  const pct = useMemo(() => {
    if (!usage) return 0;
    return Math.min(100, Math.round((usage.storageUsed / usage.storageCap) * 100));
  }, [usage]);

  const boardLabel = ctx?.boardId ? (ctx.boardName ? `${ctx.boardName} (${ctx.boardId})` : ctx.boardId) : "Unknown board";
  const boardMismatch = noteMeta && ctx?.boardId && noteMeta.mondayBoardId !== ctx.boardId;

  if (loading) return <div className="max-w-6xl mx-auto p-8">Loading…</div>;

  return (
    <div className="max-w-6xl mx-auto px-6 py-6">
      {sessionError && (
        <div className="fixed bottom-4 right-4 flex items-center gap-3 rounded-md bg-red-600 px-4 py-2 text-sm text-white shadow-lg">
          <span>Session expired — please reload the board.</span>
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
              className="rounded-md bg-[#0073EA] px-4 py-2 text-sm text-white flex items-center gap-1 transition hover:bg-[#005EB8] hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60"
            >
              <i data-lucide="user-plus" className="w-4 h-4" />
              {addingViewer ? "Adding…" : "Add viewer"}
            </button>
          </div>
        </div>
        <div className="p-4 text-sm">
          {viewerError && <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">{viewerError}</div>}
          {viewers.length === 0 ? (
            <div className="text-gray-400">No viewers added yet. The note and file authors are added automatically.</div>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {viewers.map((viewerId) => (
                <li key={viewerId} className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-xs text-gray-700">
                  {viewerId}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Notes */}
      {activeTab === "notes" && (
        <div className="mt-6 bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="flex items-center justify-between border-b border-gray-100 p-4">
            <div className="flex items-center gap-2">
              <i data-lucide="edit-3" className="w-4 h-4 text-[#0073EA]" />
              <h2 className="text-sm font-medium text-gray-700">Board Notes</h2>
              <span className="text-xs text-gray-400">{savedAt ? `Saved ${new Date(savedAt).toLocaleString()}` : "Unsaved…"}</span>
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
      )}

      {/* Files */}
      {activeTab === "files" && (
        <div className="mt-6 bg-white rounded-lg shadow-sm border border-gray-200">
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
                placeholder="Search files…"
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
                      <button onClick={() => void openFile(f)} className="text-xs text-[#0073EA] hover:underline">
                        Open
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
                {(usage.storageUsed / (1024 * 1024)).toFixed(2)} MB of {(usage.storageCap / (1024 * 1024)).toFixed(0)} MB
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}


