import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { apiRequest, socketUrl } from "./api";
import type { Chat, Message, User } from "./types";

interface Session {
  token: string;
  user: User;
}

function readSession(): Session | null {
  try {
    const value = window.localStorage.getItem("gather-session");
    return value ? (JSON.parse(value) as Session) : null;
  } catch {
    return null;
  }
}

function AuthScreen({ onLogin }: { onLogin: (session: Session) => void }) {
  const [isRegistering, setIsRegistering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const form = new FormData(event.currentTarget);
    const payload = {
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
      ...(isRegistering ? { displayName: String(form.get("displayName") ?? "") } : {})
    };
    try {
      const result = await apiRequest<Session>(`/auth/${isRegistering ? "register" : "login"}`, undefined, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      onLogin(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to sign in right now.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="brand-mark" aria-hidden="true">g</div>
        <p className="eyebrow">A quieter corner of the internet</p>
        <h1 id="auth-title">{isRegistering ? "Make room for good conversations." : "Good to see you."}</h1>
        <p className="muted auth-intro">
          {isRegistering ? "Create an account and bring your people together." : "Sign in to pick up where your conversations left off."}
        </p>
        <form onSubmit={submit} className="auth-form">
          {isRegistering && (
            <label>
              Your name
              <input name="displayName" autoComplete="name" required maxLength={60} />
            </label>
          )}
          <label>
            Email address
            <input name="email" type="email" autoComplete="email" required maxLength={254} />
          </label>
          <label>
            Password
            <input name="password" type="password" autoComplete={isRegistering ? "new-password" : "current-password"} required minLength={isRegistering ? 8 : 1} maxLength={72} />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? "One moment…" : isRegistering ? "Create account" : "Sign in"}
          </button>
        </form>
        <p className="auth-switch">
          {isRegistering ? "Already have an account?" : "New around here?"}{" "}
          <button type="button" className="text-button" onClick={() => { setError(""); setIsRegistering(!isRegistering); }}>
            {isRegistering ? "Sign in" : "Create an account"}
          </button>
        </p>
      </section>
      <aside className="auth-art" aria-hidden="true">
        <div className="art-orbit orbit-one" />
        <div className="art-orbit orbit-two" />
        <div className="art-note note-one">little things, shared often</div>
        <div className="art-note note-two">✳</div>
        <div className="art-quote">
          <span>“</span>
          <p>Somewhere between hello and see you soon, there’s a place to belong.</p>
          <small>YOUR PEOPLE ARE HERE</small>
        </div>
      </aside>
    </main>
  );
}

function chatName(chat: Chat, userId: string) {
  if (chat.title) return chat.title;
  if (chat.type === "group") return chat.members.map((member) => member.displayName).join(", ");
  return chat.members.find((member) => member._id !== userId)?.displayName ?? "Direct chat";
}

function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function ChatScreen({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingChats, setLoadingChats] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [olderAvailable, setOlderAvailable] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [showChatList, setShowChatList] = useState(true);
  const [showNewChat, setShowNewChat] = useState(false);
  const [newChatType, setNewChatType] = useState<"direct" | "group">("direct");
  const [newChatMembers, setNewChatMembers] = useState("");
  const [newChatTitle, setNewChatTitle] = useState("");
  const [creatingChat, setCreatingChat] = useState(false);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [onlineUsers, setOnlineUsers] = useState<Record<string, boolean>>({});
  const socketRef = useRef<Socket | null>(null);
  const lastSequenceByChat = useRef(new Map<string, number>());
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const selectedChat = useMemo(() => chats.find((chat) => chat._id === selectedId), [chats, selectedId]);

  useEffect(() => {
    let active = true;
    apiRequest<{ chats: Chat[] }>("/chats", session.token)
      .then(({ chats: loaded }) => {
        if (!active) return;
        loaded.forEach((chat) => {
          if (!lastSequenceByChat.current.has(chat._id)) {
            lastSequenceByChat.current.set(chat._id, chat.latestMessage?.seq ?? 0);
          }
        });
        setChats(loaded);
        setSelectedId(loaded[0]?._id ?? "");
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Your chats could not be loaded."))
      .finally(() => { if (active) setLoadingChats(false); });

    const socket = io(socketUrl(), {
      auth: { token: session.token },
      transports: ["websocket"]
    });
    socketRef.current = socket;
    socket.on("connect_error", () => setError("Live connection unavailable. Check the server and reload."));
    socket.on("presence:update", ({ userId, online }: { userId: string; online: boolean }) => {
      setOnlineUsers((current) => ({ ...current, [userId]: online }));
    });
    return () => {
      active = false;
      socket.disconnect();
      socketRef.current = null;
    };
  }, [session.token]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;
    const applyRecovery = (
      chat: Chat,
      result: { ok: boolean; messages?: Message[]; hasMore?: boolean; presence?: string[] }
    ) => {
      if (!result.ok) return;
      const recovered = [...(result.messages ?? [])];
      setOnlineUsers((current) => {
        const next = { ...current };
        chat.members.forEach((member) => {
          next[member._id] = result.presence?.includes(member._id) ?? false;
        });
        return next;
      });
      void (async () => {
        let hasMore = result.hasMore ?? false;
        while (hasMore && recovered.length > 0) {
          const afterSeq = recovered[recovered.length - 1].seq;
          const batch = await apiRequest<{ messages: Message[] }>(
            `/chats/${chat._id}/messages?afterSeq=${afterSeq}&limit=100`,
            session.token
          );
          recovered.push(...batch.messages);
          hasMore = batch.messages.length === 100;
        }
        const latestRecoveredSeq = recovered.at(-1)?.seq;
        if (latestRecoveredSeq !== undefined) {
          rememberLatestSequence(lastSequenceByChat.current, chat._id, latestRecoveredSeq);
        }
        recovered
          .filter((message) => message.senderId !== session.user.id)
          .forEach((message) => socket.emit("message:delivered", { chatId: chat._id, seq: message.seq }));
        if (selectedId === chat._id) {
          setMessages((current) => mergeMessages(current, recovered));
          return;
        }
        const latestMessage = recovered.at(-1);
        if (latestMessage) {
          setChats((current) => [
            { ...chat, latestMessage },
            ...current.filter((item) => item._id !== chat._id)
          ]);
        }
      })().catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Missed messages could not be synchronized.");
      });
    };
    const joinChats = () => chats.forEach((chat) => {
      const lastKnownSeq = lastSequenceByChat.current.get(chat._id) ?? chat.latestMessage?.seq ?? 0;
      socket.emit(
        "chat:join",
        { chatId: chat._id, afterSeq: lastKnownSeq },
        (result: { ok: boolean; messages?: Message[]; hasMore?: boolean; presence?: string[] }) => applyRecovery(chat, result)
      );
    });
    socket.on("connect", joinChats);
    if (socket.connected) joinChats();
    const receive = (message: Message) => {
      rememberLatestSequence(lastSequenceByChat.current, message.chatId, message.seq);
      if (message.chatId === selectedId) {
        setMessages((existing) => mergeMessages(existing, [message]));
      } else {
        setChats((current) => {
          const chat = current.find((item) => item._id === message.chatId);
          if (!chat) return current;
          return [
            { ...chat, latestMessage: message },
            ...current.filter((item) => item._id !== message.chatId)
          ];
        });
      }
      if (message.senderId !== session.user.id) {
        socket.emit("message:delivered", { chatId: message.chatId, seq: message.seq });
        if (message.chatId === selectedId) {
          socket.emit("message:read", { chatId: message.chatId, seq: message.seq });
        }
      }
    };
    const receiveStatus = (update: { chatId: string; seq: number; deliveredTo: string[]; readBy: string[] }) => {
      if (update.chatId !== selectedId) return;
      setMessages((current) => current.map((message) => message.seq === update.seq
        ? { ...message, deliveredTo: update.deliveredTo, readBy: update.readBy }
        : message));
    };
    const startTyping = ({ chatId, userId }: { chatId: string; userId: string }) => {
      if (chatId === selectedId) setTypingUsers((current) => current.includes(userId) ? current : [...current, userId]);
    };
    const stopTyping = ({ chatId, userId }: { chatId: string; userId: string }) => {
      if (chatId === selectedId) setTypingUsers((current) => current.filter((id) => id !== userId));
    };
    socket.on("message:new", receive);
    socket.on("message:status", receiveStatus);
    socket.on("typing:start", startTyping);
    socket.on("typing:stop", stopTyping);
    return () => {
      socket.off("connect", joinChats);
      socket.off("message:new", receive);
      socket.off("message:status", receiveStatus);
      socket.off("typing:start", startTyping);
      socket.off("typing:stop", stopTyping);
    };
  }, [chats, selectedId, session.user.id]);

  useEffect(() => {
    setTypingUsers([]);
  }, [selectedId]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket?.connected || !selectedId) return;
    messages
      .filter((message) => message.senderId !== session.user.id && !message.readBy?.includes(session.user.id))
      .forEach((message) => {
        if (!message.deliveredTo?.includes(session.user.id)) {
          socket.emit("message:delivered", { chatId: selectedId, seq: message.seq });
        }
        socket.emit("message:read", { chatId: selectedId, seq: message.seq });
      });
  }, [messages, selectedId, session.user.id]);

  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      return;
    }
    let active = true;
    setLoadingMessages(true);
    setMessages([]);
    setOlderAvailable(false);
    setError("");
    apiRequest<{ messages: Message[] }>(`/chats/${selectedId}/messages?limit=50`, session.token)
      .then(({ messages: loaded }) => {
        if (!active) return;
        const latestLoadedSeq = loaded.at(-1)?.seq;
        if (latestLoadedSeq !== undefined) {
          rememberLatestSequence(lastSequenceByChat.current, selectedId, latestLoadedSeq);
        }
        setMessages((current) => mergeMessages(loaded, current));
        setOlderAvailable(loaded.length === 50);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Messages could not be loaded."))
      .finally(() => { if (active) setLoadingMessages(false); });
    return () => { active = false; };
  }, [selectedId, session.token]);

  async function loadOlder() {
    const firstSeq = messages[0]?.seq;
    if (!firstSeq) return;
    setLoadingMessages(true);
    try {
      const result = await apiRequest<{ messages: Message[] }>(
        `/chats/${selectedId}/messages?beforeSeq=${firstSeq}&limit=50`,
        session.token
      );
      setMessages((current) => [...result.messages, ...current]);
      setOlderAvailable(result.messages.length === 50);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Older messages could not be loaded.");
    } finally {
      setLoadingMessages(false);
    }
  }

  function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    const socket = socketRef.current;
    if (!body || !socket || sending || !selectedId) return;
    setSending(true);
    setError("");
    socket.timeout(8000).emit("message:send", {
      chatId: selectedId,
      clientMsgId: crypto.randomUUID(),
      body
    }, (timeoutError: Error | null, result?: { ok: boolean; error?: string; message?: Message }) => {
      setSending(false);
      if (timeoutError || !result?.ok) {
        setError(result?.error ?? "Message could not be sent. Please try again.");
        return;
      }
      setDraft("");
      const savedMessage = result.message;
      if (savedMessage) {
        rememberLatestSequence(lastSequenceByChat.current, selectedId, savedMessage.seq);
        setMessages((current) => mergeMessages(current, [savedMessage]));
      }
      setChats((current) => {
        const active = current.find((chat) => chat._id === selectedId);
        if (!active) return current;
        return [
          { ...active, latestMessage: savedMessage ?? active.latestMessage },
          ...current.filter((chat) => chat._id !== selectedId)
        ];
      });
      setShowChatList(false);
    });
  }

  async function createChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreatingChat(true);
    setError("");
    const members = newChatMembers.split(",").map((email) => email.trim()).filter(Boolean);
    try {
      const result = await apiRequest<{ chat: Chat }>("/chats", session.token, {
        method: "POST",
        body: JSON.stringify({
          type: newChatType,
          members,
          ...(newChatType === "group" && newChatTitle.trim() ? { title: newChatTitle.trim() } : {})
        })
      });
      const chat = { ...result.chat, latestMessage: null };
      lastSequenceByChat.current.set(chat._id, 0);
      setChats((current) => [chat, ...current.filter((item) => item._id !== chat._id)]);
      setSelectedId(chat._id);
      setShowChatList(false);
      setShowNewChat(false);
      setNewChatMembers("");
      setNewChatTitle("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The conversation could not be created.");
    } finally {
      setCreatingChat(false);
    }
  }

  function handleDraftChange(value: string) {
    setDraft(value);
    if (!selectedId || !socketRef.current) return;
    socketRef.current.emit(value.trim() ? "typing:start" : "typing:stop", selectedId);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    if (value.trim()) {
      typingTimer.current = setTimeout(() => socketRef.current?.emit("typing:stop", selectedId), 900);
    }
  }

  return (
    <main className={`workspace ${showChatList ? "show-chat-list" : ""}`}>
      <aside className="sidebar">
        <header className="sidebar-top">
          <div className="brand-lockup"><span className="brand-dot">g</span><span>gather</span></div>
          <button type="button" className="icon-button" onClick={onLogout} aria-label="Sign out" title="Sign out">↗</button>
        </header>
        <div className="sidebar-heading">
          <div><p className="eyebrow">YOUR SPACE</p><h1>Conversations</h1></div>
          <div className="sidebar-actions">
            <span className="chat-count">{chats.length}</span>
            <button type="button" className="new-chat-button" onClick={() => setShowNewChat(true)} aria-label="Start a new conversation">+</button>
          </div>
        </div>
        <div className="chat-list" aria-label="Chat list">
          {loadingChats ? <p className="state-copy">Finding your conversations…</p> : error && chats.length === 0 ? (
            <p className="state-error" role="alert">{error}</p>
          ) : chats.length === 0 ? (
            <div className="empty-list"><span>✳</span><h2>A little quiet here</h2><p>When someone starts a chat with you, it’ll show up here.</p></div>
          ) : chats.map((chat) => {
            const name = chatName(chat, session.user.id);
            return (
              <button type="button" key={chat._id} className={`chat-row ${selectedId === chat._id ? "selected" : ""}`} onClick={() => { setSelectedId(chat._id); setShowChatList(false); }}>
                <span className={`avatar ${chat.type === "group" ? "avatar-group" : ""}`}>{initials(name)}</span>
                <span className="chat-copy"><strong>{name}</strong><span>{chat.latestMessage?.body ?? (chat.type === "group" ? "Group conversation" : "Say hello")}</span></span>
                {chat.type === "group" && <span className="member-count">{chat.members.length}</span>}
              </button>
            );
          })}
        </div>
        <footer className="profile-card">
          <span className="avatar avatar-self">{initials(session.user.displayName)}</span>
          <span><strong>{session.user.displayName}</strong><small>Here for a good chat</small></span>
        </footer>
      </aside>

      <section className="conversation" aria-label="Conversation">
        {selectedChat ? (
          <>
            <header className="conversation-header">
              <button type="button" className="mobile-back" onClick={() => setShowChatList(true)} aria-label="Back to conversations">‹</button>
              <span className={`avatar ${onlineUsers[selectedChat.members.find((member) => member._id !== session.user.id)?._id ?? ""] ? "avatar-online" : ""}`}>{initials(chatName(selectedChat, session.user.id))}</span>
              <div><h2>{chatName(selectedChat, session.user.id)}</h2><p>{selectedChat.type === "group" ? `${selectedChat.members.length} people` : onlineUsers[selectedChat.members.find((member) => member._id !== session.user.id)?._id ?? ""] ? "Here now" : "A conversation just for you two"}</p></div>
              <button type="button" className="mobile-signout" onClick={onLogout}>Sign out</button>
            </header>
            <div className="message-scroll" aria-live="polite" aria-relevant="additions">
              {olderAvailable && <button type="button" className="load-older" onClick={loadOlder} disabled={loadingMessages}>{loadingMessages ? "Loading…" : "Load earlier messages"}</button>}
              {loadingMessages && messages.length === 0 ? <p className="state-copy">Opening conversation…</p> : messages.length === 0 ? (
                <div className="conversation-empty"><div className="empty-spark">✳</div><h3>A fresh beginning</h3><p>Send the first message and see where it goes.</p></div>
              ) : messages.map((message) => {
                const own = message.senderId === session.user.id;
                const sender = selectedChat.members.find((member) => member._id === message.senderId)?.displayName ?? "Someone";
                return (
                  <article className={`message-line ${own ? "message-own" : ""}`} key={message._id}>
                    {!own && <span className="avatar avatar-small">{initials(sender)}</span>}
                    <div className="message-content">
                      {!own && <span className="sender-name">{sender}</span>}
                      <p className="bubble">{message.body}</p>
                      <span className="message-meta">
                        <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
                        {own && message.deliveredTo?.length > 0 && <span title="Delivered"> · Delivered</span>}
                        {own && message.readBy?.length > 0 && <span title="Read"> · Read</span>}
                      </span>
                    </div>
                  </article>
                );
              })}
              {typingUsers.length > 0 && <p className="typing-indicator">{typingUsers.map((id) => selectedChat.members.find((member) => member._id === id)?.displayName ?? "Someone").join(", ")} typing…</p>}
            </div>
            {error && <p className="inline-error" role="alert">{error}</p>}
            <form className="composer" onSubmit={sendMessage}>
              <label className="sr-only" htmlFor="message-draft">Write a message</label>
              <input id="message-draft" value={draft} onChange={(event) => handleDraftChange(event.target.value)} placeholder="Write something kind…" maxLength={4000} autoComplete="off" />
              <button type="submit" disabled={!draft.trim() || sending} aria-label="Send message">{sending ? "…" : "Send"} <span aria-hidden="true">↗</span></button>
            </form>
            <p className="composer-hint">A little kindness travels a long way.</p>
          </>
        ) : (
          <div className="welcome-empty">
            {error && <p className="inline-error" role="alert">{error}</p>}
            <div className="empty-spark">✳</div><p className="eyebrow">A PLACE TO PICK UP</p><h2>Your conversations live here.</h2><p>Choose a chat on the left, or wait for someone to say hello.</p>
          </div>
        )}
      </section>
      {showNewChat && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowNewChat(false); }}>
          <section className="new-chat-modal" role="dialog" aria-modal="true" aria-labelledby="new-chat-title">
            <button type="button" className="modal-close" onClick={() => setShowNewChat(false)} aria-label="Close">×</button>
            <p className="eyebrow">MAKE A LITTLE SPACE</p>
            <h2 id="new-chat-title">Start a conversation</h2>
            <form onSubmit={createChat}>
              <label>Conversation type
                <select value={newChatType} onChange={(event) => setNewChatType(event.target.value as "direct" | "group")}>
                  <option value="direct">One-to-one</option>
                  <option value="group">Group</option>
                </select>
              </label>
              {newChatType === "group" && <label>Group name
                <input value={newChatTitle} onChange={(event) => setNewChatTitle(event.target.value)} maxLength={80} placeholder="Optional" />
              </label>}
              <label>{newChatType === "group" ? "People’s email addresses (comma separated)" : "Their email address"}
                <input type="text" required value={newChatMembers} onChange={(event) => setNewChatMembers(event.target.value)} placeholder="friend@example.com" />
              </label>
              {error && <p className="form-error" role="alert">{error}</p>}
              <button className="primary-button" type="submit" disabled={creatingChat}>{creatingChat ? "Creating…" : "Create conversation"}</button>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}

function mergeMessages(current: Message[], incoming: Message[]) {
  const messages = new Map(current.map((message) => [message._id, message]));
  incoming.forEach((message) => {
    const existing = messages.get(message._id);
    messages.set(message._id, {
      ...existing,
      ...message,
      deliveredTo: [...new Set([...(existing?.deliveredTo ?? []), ...(message.deliveredTo ?? [])])],
      readBy: [...new Set([...(existing?.readBy ?? []), ...(message.readBy ?? [])])]
    });
  });
  return [...messages.values()].sort((left, right) => left.seq - right.seq);
}

function rememberLatestSequence(sequences: Map<string, number>, chatId: string, sequence: number) {
  sequences.set(chatId, Math.max(sequences.get(chatId) ?? 0, sequence));
}

export default function App() {
  const [session, setSession] = useState<Session | null>(() => readSession());

  useEffect(() => {
    if (session) window.localStorage.setItem("gather-session", JSON.stringify(session));
    else window.localStorage.removeItem("gather-session");
  }, [session]);

  return session
    ? <ChatScreen session={session} onLogout={() => setSession(null)} />
    : <AuthScreen onLogin={setSession} />;
}
