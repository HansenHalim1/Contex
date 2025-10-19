"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import mondaySdk from "monday-sdk-js";

type Ctx = { accountId: string; boardId: string; userId?: string; boardName?: string };
type FileRow = { id: string; name: string; size_bytes: number; content_type: string };

const mnd = mondaySdk();

export default function BoardView() {
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState("");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [files, setFiles] = useState<FileRow[]>([]);
  const [usage, setUsage] = useState<{ boardsUsed: number; boardsCap: number; storageUsed: number; storageCap: number } | null>(null);
  const [activeTab, setActiveTab] = useState<"notes" | "files">("notes");
  const saveTimer = useRef<NodeJS.Timeout | null>(null);
  const pendingHtml = useRef<string | null>(null);
  const ctxRef = useRef<Ctx | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [q, setQ] = useState("");

  // INIT monday context → resolve tenant/board → load data
  useEffect(() => {
    (async () => {
      const res = await mnd.get("context"); // { account: {id}, boardId, user}
      const data = res?.data;

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
        console.error("Missing account or board id from monday context", res?.data);
        setLoading(false);
        return;
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

      const r = await fetch("/api/context/resolve", { method: "POST", body: JSON.stringify(c) });
      if (!r.ok) {
        alert("This board exceeds your plan limit. Please upgrade.");
        setLoading(false);
        return;
      }

      await Promise.all([loadNotes(c), loadFiles(c, ""), loadUsage(c)]);
      setLoading(false);
    })();
  }, []);

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

  async function loadNotes(c: Ctx) {
    const r = await fetch(`/api/notes?accountId=${c.accountId}&boardId=${c.boardId}`);
    const data = await r.json();
    setNotes(data.html || "");
    setSavedAt(data.updated_at || null);
    pendingHtml.current = null;
  }

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.innerHTML !== notes) {
      editor.innerHTML = notes;
    }
  }, [notes]);

  useEffect(() => {
    ctxRef.current = ctx;
  }, [ctx]);

  const flushPendingSave = useCallback(async () => {
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
      const r = await fetch(`/api/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...currentCtx, html })
      });
      if (r.ok) {
        const j = await r.json();
        setSavedAt(j.updated_at);
      } else {
        console.error("Save failed", r.status);
        pendingHtml.current = html;
        scheduleRetry();
      }
    } catch (error) {
      console.error("Failed to save notes", error);
      pendingHtml.current = html;
       scheduleRetry();
    }
  }, [setSavedAt]);

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
    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        void flushPendingSave();
      }
    }

    function handleBeforeUnload() {
      void flushPendingSave();
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [flushPendingSave]);

  async function loadFiles(c: Ctx, q: string) {
    const r = await fetch(`/api/files/list?accountId=${c.accountId}&boardId=${c.boardId}&q=${encodeURIComponent(q)}`);
    const j = await r.json();
    setFiles(j.files || []);
  }

  async function loadUsage(c: Ctx) {
    const r = await fetch(`/api/usage?accountId=${c.accountId}&boardId=${c.boardId}`);
    const j = await r.json();
    setUsage(j);
  }

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    if (!ctx || !e.target.files?.length) return;
    for (const file of Array.from(e.target.files)) {
      // ask server for signed upload URL
      const pre = await fetch(`/api/files/sign-upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...ctx,
          filename: file.name,
          contentType: file.type || "application/octet-stream",
          sizeBytes: file.size
        })
      });

      if (!pre.ok) {
        alert("Storage cap reached. Please upgrade.");
        return;
      }

      const { uploadUrl, storagePath } = await pre.json();

      // PUT to signed URL
      const put = await fetch(uploadUrl, { method: "PUT", body: file, headers: { "Content-Type": file.type || "application/octet-stream" } });
      if (!put.ok) {
        alert("Upload failed.");
        return;
      }

      // confirm to DB
      const conf = await fetch(`/api/files/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...ctx,
          name: file.name,
          sizeBytes: file.size,
          contentType: file.type || "application/octet-stream",
          storagePath
        })
      });

      if (!conf.ok) {
        alert("Confirm failed.");
        return;
      }
    }
    await loadFiles(ctx, q);
    await loadUsage(ctx);
    if (e.target) e.target.value = "";
  }

  async function openFile(file: FileRow) {
    if (!ctx) return;
    const params = new URLSearchParams({
      accountId: ctx.accountId,
      boardId: ctx.boardId,
      fileId: file.id
    });
    try {
      const res = await fetch(`/api/files/download?${params.toString()}`);
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
  }

  const pct = useMemo(() => {
    if (!usage) return 0;
    return Math.min(100, Math.round((usage.storageUsed / usage.storageCap) * 100));
  }, [usage]);
  const boardLabel = ctx?.boardId ? (ctx.boardName ? `${ctx.boardName} (${ctx.boardId})` : ctx.boardId) : "Unknown board";

  if (loading) return <div className="max-w-6xl mx-auto p-8">Loading…</div>;

  return (
    <div className="max-w-6xl mx-auto px-6 py-6">
      {/* Header */}
      <div className="flex items-center justify-between bg-white rounded-lg p-5 shadow-sm border border-gray-100">
        <div className="flex items-center gap-2">
          <i data-lucide="notebook" className="w-5 h-5 text-[#0073EA]" />
          <div>
            <h1 className="text-xl font-semibold text-[#1C1C1C]">Context — Board Knowledge Hub</h1>
            <p className="text-sm text-gray-500">
              Notes & files for board <span className="font-medium text-[#0073EA]">{boardLabel}</span>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 w-[380px] justify-end">
          {usage && (
            <div className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-600">
              Storage: {(usage.storageUsed / (1024 * 1024)).toFixed(2)} MB used
            </div>
          )}
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
                  setQ(e.target.value);
                  if (ctx) await loadFiles(ctx, e.target.value);
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
                      <button
                        onClick={() => void openFile(f)}
                        className="text-xs text-[#0073EA] hover:underline"
                      >
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
