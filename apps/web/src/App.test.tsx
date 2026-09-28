import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import App from "./App";

vi.mock("socket.io-client", () => ({
  io: vi.fn(() => ({
    connected: false,
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn()
  }))
}));

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data
  };
}

describe("chat client", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("shows an accessible sign-in error when credentials are rejected", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "Email or password is incorrect." }, 401)));
    render(<App />);

    await user.type(screen.getByLabelText("Email address"), "person@example.test");
    await user.type(screen.getByLabelText("Password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Email or password is incorrect.");
  });

  it("registers and renders the empty chat-list and conversation states", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        token: "signed-token",
        user: { id: "user-1", email: "person@example.test", displayName: "Taylor" }
      }, 201))
      .mockResolvedValueOnce(jsonResponse({ chats: [] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Create an account" }));
    await user.type(screen.getByLabelText("Your name"), "Taylor");
    await user.type(screen.getByLabelText("Email address"), "person@example.test");
    await user.type(screen.getByLabelText("Password"), "a-secure-password");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("A little quiet here")).toBeInTheDocument();
    expect(screen.getByText("Your conversations live here.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/auth/register", expect.objectContaining({
      method: "POST"
    }));
    await waitFor(() => expect(window.localStorage.getItem("gather-session")).toContain("signed-token"));
  });

  it("does not carry one chat's messages into another selected conversation", async () => {
    const user = userEvent.setup();
    const session = {
      token: "signed-token",
      user: { id: "me", email: "me@example.test", displayName: "Taylor" }
    };
    window.localStorage.setItem("gather-session", JSON.stringify(session));
    const chats = [
      {
        _id: "chat-one",
        type: "direct",
        members: [
          { _id: "me", email: "me@example.test", displayName: "Taylor" },
          { _id: "friend-one", email: "one@example.test", displayName: "Alex" }
        ],
        latestMessage: null
      },
      {
        _id: "chat-two",
        type: "direct",
        members: [
          { _id: "me", email: "me@example.test", displayName: "Taylor" },
          { _id: "friend-two", email: "two@example.test", displayName: "Sam" }
        ],
        latestMessage: null
      }
    ];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/chats")) return Promise.resolve(jsonResponse({ chats }));
      if (url.includes("chat-one")) {
        return Promise.resolve(jsonResponse({ messages: [{
          _id: "message-one",
          chatId: "chat-one",
          senderId: "friend-one",
          clientMsgId: "one",
          seq: 1,
          body: "First note",
          createdAt: "2026-01-01T12:00:00.000Z",
          deliveredTo: [],
          readBy: []
        }] }));
      }
      return Promise.resolve(jsonResponse({ messages: [{
        _id: "message-two",
        chatId: "chat-two",
        senderId: "friend-two",
        clientMsgId: "two",
        seq: 1,
        body: "Second note",
        createdAt: "2026-01-01T12:01:00.000Z",
        deliveredTo: [],
        readBy: []
      }] }));
    }));
    render(<App />);

    expect(await screen.findByText("First note")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Sam/ }));
    expect(await screen.findByText("Second note")).toBeInTheDocument();
    expect(screen.queryByText("First note")).not.toBeInTheDocument();
  });
});
