export interface User {
  id: string;
  email: string;
  displayName: string;
}

export interface ChatMember {
  _id: string;
  email: string;
  displayName: string;
}

export interface Message {
  _id: string;
  chatId: string;
  senderId: string;
  clientMsgId: string;
  seq: number;
  body: string;
  createdAt: string;
}

export interface Chat {
  _id: string;
  type: "direct" | "group";
  title?: string;
  members: ChatMember[];
  latestMessage: Message | null;
}
