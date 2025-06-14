# XMTP Chat for Xanthrex

This project provides the screen and service implementation for the XMTP decentralized messaging protocol within the Xanthrex application. It specifically handles the chat functionality, allowing users to send and receive messages securely using their Ethereum addresses.

The core components include:

*   [`useXMTPService.ts`](useXMTPServe.ts): A custom React hook that manages the XMTP client lifecycle, handles wallet connection, initializes the client, loads and streams conversations and messages, and provides functions for sending messages and starting new conversations.
*   [`XMTPChat.tsx`](XMTPChat.tsx): A React component that utilizes the `useXMTPService` hook to render the chat user interface, displaying conversations, messages, and providing input fields for sending messages and starting new chats.

## Interface

The following image shows the user interface for the XMTP chat component:

![XMTP Chat Interface](Capture d’écran 2025-06-14 à 08.09.36.png)