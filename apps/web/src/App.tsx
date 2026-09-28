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
    const value = localStorage.getItem("gather-session");
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
  const socketRef = useRef<Socket | null>(null);
  const selectedChat = useMemo(() => chats.find((chat) => chat._id === selectedId), [chats, selectedId]);

  useEffect(() => {
    let active = true;
    apiRequest<{ chats: Chat[] }>("/chats", session.token)
      .then(({ chats: loaded }) => {
        if (!active) return;
        setChats(loaded);
        setSelectedId(loaded[0]?._id ?? "");
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Your chats could not be loaded."))
      .finally(() => { if (active) setLoadingChats(false); });

    const socket = io(socketUrl(), { auth: { token: session.token } });
    socketRef.current = socket;
    socket.on("connect_error", () => setError("Live connection unavailable. Check the server and reload."));
    return () => {
      active = false;
      socket.disconnect();
      socketRef.current = null;
    };
  }, [session.token]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;
    const joinChats = () => chats.forEach((chat) => socket.emit("chat:join", chat._id));
    socket.on("connect", joinChats);
    if (socket.connected) joinChats();
    const receive = (message: Message) => {
      if (message.chatId !== selectedId) return;
      setMessages((existing) => existing.some((item) => item._id === message._id)
        ? existing
        : [...existing, message].sort((a, b) => a.seq - b.seq));
    };
    socket.on("message:new", receive);
    return () => {
      socket.off("connect", joinChats);
      socket.off("message:new", receive);
    };
  }, [chats, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      return;
    }
    let active = true;
    setLoadingMessages(true);
    setError("");
    apiRequest<{ messages: Message[] }>(`/chats/${selectedId}/messages?limit=50`, session.token)
      .then(({ messages: loaded }) => {
        if (!active) return;
        setMessages(loaded);
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
      setChats((current) => {
        const active = current.find((chat) => chat._id === selectedId);
        if (!active) return current;
        return [
          { ...active, latestMessage: result?.message ?? active.latestMessage },
          ...current.filter((chat) => chat._id !== selectedId)
        ];
      });
      setShowChatList(false);
    });
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
          <span className="chat-count">{chats.length}</span>
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
              <span className="avatar">{initials(chatName(selectedChat, session.user.id))}</span>
              <div><h2>{chatName(selectedChat, session.user.id)}</h2><p>{selectedChat.type === "group" ? `${selectedChat.members.length} people` : "A conversation just for you two"}</p></div>
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
                      <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
                    </div>
                  </article>
                );
              })}
            </div>
            {error && <p className="inline-error" role="alert">{error}</p>}
            <form className="composer" onSubmit={sendMessage}>
              <label className="sr-only" htmlFor="message-draft">Write a message</label>
              <input id="message-draft" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Write something kind…" maxLength={4000} autoComplete="off" />
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
    </main>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(() => readSession());

  useEffect(() => {
    if (session) localStorage.setItem("gather-session", JSON.stringify(session));
    else localStorage.removeItem("gather-session");
  }, [session]);

  return session
    ? <ChatScreen session={session} onLogout={() => setSession(null)} />
    : <AuthScreen onLogin={setSession} />;
}
