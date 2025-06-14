import { useState, useEffect, useCallback, useRef } from 'react';
import { useAccount, useWalletClient } from 'wagmi';
import { toBytes } from 'viem';

// --- Imports from the browser SDK ---
import {
  Client,
  Dm,
  Group,
  type Signer,
  type Identifier,
  type DecodedMessage,
  type Conversation,
  type ClientOptions,
} from '@xmtp/browser-sdk';

// --- Content Codecs ---
import { TextCodec } from '@xmtp/content-type-text';
import { GroupUpdatedCodec, type GroupUpdated } from '@xmtp/content-type-group-updated';
import { ContentTypeId } from '@xmtp/content-type-primitives';
import { type ExtractCodecContentTypes } from '@xmtp/browser-sdk';
import { IdentifierKind } from '@xmtp/wasm-bindings';

// Define the content types that our client will support
type ClientContentTypes = ExtractCodecContentTypes<[TextCodec, GroupUpdatedCodec]>;

export interface XMTPConversation {
  id: string;
  peerAddress: string;
  createdAt: Date;
  lastMessage?: {
    content: string;
    sentAt: Date;
    senderAddress: string;
  };
}

export interface XMTPMessage {
  id: string;
  content: string;
  senderAddress: string;
  sentAt: Date;
  conversationId: string;
}

// Utility function to safely handle ArrayBuffer operations
const safeArrayBufferOperation = async <T>(operation: () => Promise<T> | T, fallback: T): Promise<T> => {
  try {
    const result = await operation();
    return result;
  } catch (operationError) {
    if (
      operationError instanceof TypeError &&
      (operationError.message.includes('detached ArrayBuffer') ||
        operationError.message.includes('Cannot perform %TypedArray%.prototype.set') ||
        operationError.message.includes('memory access out of bounds'))
    ) {
      console.warn('ArrayBuffer operation failed, using fallback:', operationError.message);
      return fallback;
    }
    throw operationError;
  }
};

// Utility function for sync operations
const safeArrayBufferOperationSync = <T>(operation: () => T, fallback: T): T => {
  try {
    return operation();
  } catch (operationError) {
    if (
      operationError instanceof TypeError &&
      (operationError.message.includes('detached ArrayBuffer') ||
        operationError.message.includes('Cannot perform %TypedArray%.prototype.set') ||
        operationError.message.includes('memory access out of bounds'))
    ) {
      console.warn('ArrayBuffer sync operation failed, using fallback:', operationError.message);
      return fallback;
    }
    throw operationError;
  }
};

// Enhanced error handler for XMTP operations
const handleXMTPError = (err: any, context: string): string => {
  console.error(`❌ ${context}:`, err);

  if (err instanceof TypeError) {
    if (
      err.message.includes('detached ArrayBuffer') ||
      err.message.includes('Cannot perform %TypedArray%.prototype.set') ||
      err.message.includes('memory access out of bounds')
    ) {
      return 'Memory buffer error detected. Please refresh the page.';
    }
  }

  if (err instanceof Error) {
    if (err.message.includes('CORS')) {
      return 'CORS Error: Please check your browser settings.';
    }
    if (err.message.includes('fetch')) {
      return 'Network Error: Unable to connect to XMTP network.';
    }
    return err.message;
  }

  return 'An unexpected error occurred';
};

// Utility function to validate XMTP client
const isValidXMTPClient = (client: any): boolean => {
  return client && typeof client === 'object' && client.conversations && typeof client.conversations.list === 'function';
};

// Helper to normalize addresses
const normalizeAddress = (address: string): string => {
  return address.toLowerCase().trim();
};

export const useXMTPService = () => {
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();

  const [client, setClient] = useState<Client<ClientContentTypes> | null>(null);
  const [inboxId, setInboxId] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [conversations, setConversations] = useState<XMTPConversation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [lastMessageTimestamp, setLastMessageTimestamp] = useState<number>(0);
  const [clientCreationAttempts, setClientCreationAttempts] = useState(0);
  const [processedMessageIds, setProcessedMessageIds] = useState<Set<string>>(new Set());

  // Refs for polling
  const messagePollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const conversationPollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const initializationTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const onMessageCallbackRef = useRef<((message: XMTPMessage) => void) | null>(null);
  const onNewConversationCallbackRef = useRef<((conversation: XMTPConversation) => void) | null>(null);

  // Ref to avoid multiple initializations
  const isInitializingRef = useRef(false);

  // Ref for current conversations (to avoid unnecessary re-renders)
  const conversationsRef = useRef<XMTPConversation[]>([]);

  /**
   * Enhanced signer with ArrayBuffer safety
   */
  const createSigner = useCallback((walletClientTemp: any, addressTemp: string): Signer => {
    const accountIdentifier: Identifier = {
      identifier: normalizeAddress(addressTemp),
      identifierKind: 'Ethereum',
    };

    return {
      type: 'EOA',
      getIdentifier: () => accountIdentifier,
      async signMessage(message: string): Promise<Uint8Array> {
        console.log('🔐 Signing message with wallet client:', message);
        try {
          const signature = await walletClientTemp.signMessage({
            account: addressTemp as `0x${string}`,
            message,
          });

          return safeArrayBufferOperationSync(() => toBytes(signature), new Uint8Array());
        } catch (signError) {
          console.error('❌ Failed to sign message:', signError);
          throw new Error(handleXMTPError(signError, 'Message signing failed'));
        }
      },
    };
  }, []);

  /**
   * Safe client cleanup
   */
  const cleanupClient = useCallback(() => {
    try {
      // Stop all polling intervals
      if (messagePollingIntervalRef.current) {
        clearInterval(messagePollingIntervalRef.current);
        messagePollingIntervalRef.current = null;
      }

      if (conversationPollingIntervalRef.current) {
        clearInterval(conversationPollingIntervalRef.current);
        conversationPollingIntervalRef.current = null;
      }

      if (initializationTimeoutRef.current) {
        clearTimeout(initializationTimeoutRef.current);
        initializationTimeoutRef.current = null;
      }

      // Reset refs
      isInitializingRef.current = false;
      onMessageCallbackRef.current = null;
      onNewConversationCallbackRef.current = null;
      conversationsRef.current = [];

      // Reset state
      setClient(null);
      setInboxId(null);
      setIsReady(false);
      setIsPolling(false);
      setConversations([]);
      setProcessedMessageIds(new Set());
      setIsInitializing(false);
      setLastMessageTimestamp(0);

      console.log('🧹 Client cleanup completed');
    } catch (cleanupError) {
      console.warn('Warning during client cleanup:', cleanupError);
    }
  }, []);

  /**
   * Enhanced client initialization with better error handling
   */
  const initializeClient = useCallback(async () => {
    // Preliminary checks with refs
    if (!walletClient || !address || !isConnected || isInitializingRef.current) {
      return;
    }

    if (clientCreationAttempts >= 3) {
      setError('Maximum initialization attempts reached. Please refresh the page.');
      return;
    }

    // Mark initialization in progress
    isInitializingRef.current = true;
    setIsInitializing(true);
    setError(null);
    setClientCreationAttempts(prev => prev + 1);

    try {
      console.log('🔌 Initializing XMTP client with address:', address);

      cleanupClient();

      initializationTimeoutRef.current = setTimeout(() => {
        if (isInitializingRef.current) {
          setError('Initialization timeout. Please try again.');
          setIsInitializing(false);
          isInitializingRef.current = false;
        }
      }, 60000);

      const signer = createSigner(walletClient, address);

      const clientOptions: ClientOptions = {
        env: 'production',
        codecs: [new TextCodec(), new GroupUpdatedCodec()],
        dbPath: `xmtp-v3-db-${normalizeAddress(address)}`,
        structuredLogging: true,
        loggingLevel: 'info',
      };

      console.log('📋 Creating XMTP client with options:', clientOptions);

      const xmtpClient = await safeArrayBufferOperation(
        async () =>
          await Client.create<[TextCodec, GroupUpdatedCodec]>(signer, {
            ...clientOptions,
            codecs: [new TextCodec(), new GroupUpdatedCodec()],
          }),
        null,
      );

      if (!xmtpClient) {
        throw new Error('Failed to create XMTP client due to ArrayBuffer issues');
      }

      console.log('✅ XMTP client created successfully');

      // Immediate sync after creation
      try {
        console.log('🔄 Initial sync after client creation...');
        await safeArrayBufferOperation(async () => await xmtpClient.conversations.syncAll(), undefined);
        console.log('✅ Initial sync completed');
      } catch (syncError) {
        console.warn('⚠️ Initial sync failed, but continuing:', syncError);
      }

      const userInboxId = xmtpClient.inboxId;

      setClient(xmtpClient);
      setInboxId(userInboxId || null);
      setIsReady(true);
      setClientCreationAttempts(0);

      console.log('✅ XMTP client ready with inbox ID:', userInboxId);
    } catch (initError) {
      const errorMessage = handleXMTPError(initError, 'XMTP client initialization failed');
      setError(errorMessage);

      if (errorMessage.includes('buffer') || errorMessage.includes('ArrayBuffer')) {
        setError('Memory error detected. Please refresh the page to continue.');
      }
    } finally {
      setIsInitializing(false);
      isInitializingRef.current = false;
      if (initializationTimeoutRef.current) {
        clearTimeout(initializationTimeoutRef.current);
        initializationTimeoutRef.current = null;
      }
    }
  }, [walletClient, address, isConnected, createSigner, cleanupClient, clientCreationAttempts]);

  /**
   * Auto-initialize when wallet is connected
   */
  useEffect(() => {
    if (isConnected && address && walletClient && !client && !isInitializingRef.current) {
      void initializeClient();
    }
  }, [isConnected, address, walletClient]);

  /**
   * Helper to get Ethereum address from inboxId
   */
  const getEthereumAddressFromInboxId = useCallback(
    async (inboxIdTemp: string): Promise<string | null> => {
      if (!client || !isReady) return null;

      try {
        const inboxStates = await safeArrayBufferOperation(
          async () => await client.preferences.inboxStateFromInboxIds([inboxIdTemp], true),
          [],
        );

        if (inboxStates && inboxStates.length > 0) {
          const state = inboxStates[0];
          if (state.accountIdentifiers && state.accountIdentifiers.length > 0) {
            const ethIdentity = state.accountIdentifiers.find((id: Identifier) => id.identifierKind === 'Ethereum');
            if (ethIdentity) {
              return ethIdentity.identifier;
            }
          }
        }
        return null;
      } catch (err) {
        console.warn('Failed to get Ethereum address from inbox ID:', err);
        return null;
      }
    },
    [client, isReady],
  );

  /**
   * Enhanced conversation loading with better message detection
   */
  const loadConversations = useCallback(async () => {
    if (!client || !isReady || !isValidXMTPClient(client)) {
      console.warn('Client not ready or invalid for loading conversations');
      return;
    }

    try {
      console.log('📋 Loading XMTP conversations...');

      // Sync before loading
      try {
        await safeArrayBufferOperation(async () => await client.conversations.syncAll(), undefined);
        console.log('🔄 Sync completed before loading conversations');
      } catch (syncError) {
        console.warn('⚠️ Sync failed before loading, continuing anyway:', syncError);
      }

      let convos;
      try {
        convos = await client.conversations.list();
        if (!convos || !Array.isArray(convos)) {
          console.warn('No conversations found or invalid response');
          convos = [];
        }
      } catch (listError) {
        console.error('Error listing conversations:', listError);
        try {
          convos = await safeArrayBufferOperation(async () => await client.conversations.list(), []);
          if (!convos || !Array.isArray(convos)) {
            convos = [];
          }
        } catch (fallbackError) {
          console.error('Fallback also failed:', fallbackError);
          convos = [];
        }
      }

      console.log(`📋 Found ${convos.length} conversations`);

      const formattedConversations: XMTPConversation[] = await Promise.all(
        convos.map(async (convo, index) => {
          console.log(`📋 Processing conversation ${index + 1}/${convos.length}: ${convo.id}`);

          let peerAddress = 'Unknown';
          let lastMessage: XMTPConversation['lastMessage'] = undefined;

          try {
            if (convo instanceof Dm) {
              const peerInboxId = await safeArrayBufferOperation(async () => await convo.peerInboxId(), null);
              console.log(`👤 Peer inbox ID for conversation ${convo.id}: ${peerInboxId}`);

              if (peerInboxId) {
                const ethAddress = await getEthereumAddressFromInboxId(peerInboxId);
                if (ethAddress) {
                  peerAddress = ethAddress;
                  console.log(`👤 Resolved peer address: ${peerAddress}`);
                } else {
                  peerAddress = peerInboxId;
                }
              }
            } else if (convo instanceof Group) {
              peerAddress = (convo as any).name || 'Group Chat';
            }
          } catch (inboxErr) {
            console.warn('Could not get peer info for conversation:', convo.id, inboxErr);
          }

          try {
            const messages = await safeArrayBufferOperation(async () => await convo.messages({ limit: BigInt(5), direction: 1 }), []);

            console.log(`📨 Found ${messages.length} messages in conversation ${convo.id}`);

            if (messages.length > 0) {
              const recentMessage = messages[0];
              const senderAddress = await getEthereumAddressFromInboxId(recentMessage.senderInboxId || '');

              lastMessage = {
                content: (recentMessage.content as string) || '[Unsupported Content]',
                sentAt: new Date(Number(recentMessage.sentAtNs) / 1_000_000),
                senderAddress: senderAddress || recentMessage.senderInboxId || 'Unknown',
              };

              console.log(`📨 Last message in ${convo.id}:`, lastMessage);
            }
          } catch (msgErr) {
            console.warn('Could not load messages for conversation:', convo.id, msgErr);
          }

          return {
            id: convo.id,
            peerAddress,
            createdAt: convo.createdAt || new Date(),
            lastMessage,
          };
        }),
      );

      formattedConversations.sort((a, b) => {
        const aTime = a.lastMessage?.sentAt || a.createdAt;
        const bTime = b.lastMessage?.sentAt || b.createdAt;
        return bTime.getTime() - aTime.getTime();
      });

      // Update only if conversations have changed
      const conversationsChanged = JSON.stringify(conversationsRef.current) !== JSON.stringify(formattedConversations);
      if (conversationsChanged) {
        conversationsRef.current = formattedConversations;
        setConversations(formattedConversations);
        console.log(`✅ Loaded ${formattedConversations.length} conversations`);
      }
    } catch (loadError) {
      const errorMessage = handleXMTPError(loadError, 'Failed to load conversations');
      setError(errorMessage);
    }
  }, [client, isReady, getEthereumAddressFromInboxId]);

  /**
   * Message polling - Enhanced version with better detection
   */
  const pollForNewMessages = useCallback(async () => {
    if (!client || !isReady || !isValidXMTPClient(client)) {
      console.warn('Client not ready or invalid for message polling');
      return;
    }

    try {
      // Sync before polling to make sure we have the latest messages
      try {
        await safeArrayBufferOperation(async () => await client.conversations.syncAll(), undefined);
      } catch (syncError) {
        console.warn('⚠️ Sync failed during polling, continuing anyway:', syncError);
      }

      let conversationsList;
      try {
        conversationsList = await client.conversations.list();
        if (!conversationsList || !Array.isArray(conversationsList)) {
          console.warn('No conversations found for polling');
          conversationsList = [];
        }
      } catch (listError) {
        console.error('Error listing conversations during polling:', listError);
        try {
          conversationsList = await safeArrayBufferOperation(async () => await client.conversations.list(), []);
          if (!conversationsList || !Array.isArray(conversationsList)) {
            conversationsList = [];
          }
        } catch (fallbackError) {
          console.error('Polling fallback also failed:', fallbackError);
          conversationsList = [];
        }
      }

      for (const conversation of conversationsList) {
        try {
          const messages = await safeArrayBufferOperation(
            async () =>
              await conversation.messages({
                limit: BigInt(20),
                direction: 1,
              }),
            [],
          );

          for (const message of messages) {
            const messageTimestamp = Number(message.sentAtNs) / 1_000_000;
            const messageId = message.id || `msg-${message.conversationId}-${messageTimestamp}`;

            if (messageTimestamp > lastMessageTimestamp && !processedMessageIds.has(messageId)) {
              const senderAddress = await getEthereumAddressFromInboxId(message.senderInboxId || '');

              const formattedMessage: XMTPMessage = {
                id: messageId,
                content: (message.content as string) || '[Unsupported Content]',
                senderAddress: senderAddress || message.senderInboxId || 'Unknown',
                sentAt: new Date(messageTimestamp),
                conversationId: message.conversationId || '',
              };

              console.log('📨 New message found via polling:', formattedMessage);

              // Mark message as processed
              setProcessedMessageIds(prev => new Set([...prev, messageId]));

              // Call callback if defined
              if (onMessageCallbackRef.current) {
                onMessageCallbackRef.current(formattedMessage);
              }

              // Update timestamp
              setLastMessageTimestamp(messageTimestamp);
            }
          }
        } catch (convErr) {
          console.warn('Warning checking conversation messages:', convErr);
        }
      }
    } catch (pollingError) {
      const errorMessage = handleXMTPError(pollingError, 'Error during message polling');
      if (errorMessage.includes('buffer') || errorMessage.includes('ArrayBuffer')) {
        console.error('ArrayBuffer error in polling, stopping...');
        stopMessagePolling();
        setError('Memory error in polling. Please refresh the page.');
      }
    }
  }, [client, isReady, lastMessageTimestamp, processedMessageIds, getEthereumAddressFromInboxId]);

  const canMessage = useCallback(
    async (addresses: string[]): Promise<Map<string, boolean>> => {
      // Vérifier que nous avons les éléments nécessaires
      if (!walletClient || !address || !isConnected) {
        console.error('❌ Wallet not connected or missing required data');
        const errorResult = new Map<string, boolean>();
        addresses.forEach(addr => errorResult.set(normalizeAddress(addr), false));
        return errorResult;
      }

      try {
        console.log('🔍 Checking if addresses can message:', addresses);

        // Vérifier qu'il y a au moins une adresse
        if (addresses.length === 0) {
          console.warn('⚠️ No addresses provided to check');
          return new Map<string, boolean>();
        }

        const normalizedAddresses = addresses.map(addr => normalizeAddress(addr));

        // Prendre la première adresse (on suppose qu'il n'y en a qu'une)
        const targetAddress = normalizedAddresses[0];

        // Créer le signer pour cette adresse
        const signer = createSigner(walletClient, targetAddress);

        // Récupérer l'identifiant du signer
        const signerIdentifier = await signer.getIdentifier();

        console.log('🔍 Using signer identifier for', targetAddress, ':', signerIdentifier);

        // Utiliser Client.canMessage avec le signer
        const canMessageResult = await Client.canMessage([signerIdentifier], 'production');

        console.log('🔍 canMessage result:', Array.from(canMessageResult.entries()));

        return canMessageResult;

        console.log('🔍 canMessage result:', Array.from(canMessageResult.entries()));

        return canMessageResult;
      } catch (checkError) {
        console.error('❌ Failed to check message capability:', checkError);

        // En cas d'erreur globale, retourner false pour toutes les adresses
        const errorResult = new Map<string, boolean>();
        addresses.forEach(addr => errorResult.set(normalizeAddress(addr), false));
        return errorResult;
      }
    },
    [walletClient, address, isConnected, createSigner],
  );

  /**
   * Send a message to a specific conversation - ROBUST VERSION
   */
  const sendMessage = useCallback(
    async (conversationId: string, content: string): Promise<void> => {
      if (!client || !isReady || !isValidXMTPClient(client)) {
        throw new Error('Client not ready');
      }

      if (!content.trim()) {
        throw new Error('Message content cannot be empty');
      }

      try {
        console.log('📤 Sending message to conversation:', conversationId);

        // Sync before sending to make sure we have the conversation up to date
        await safeArrayBufferOperation(async () => await client.conversations.syncAll(), undefined);

        const conversationsTemp = await client.conversations.list();
        const conversation = conversationsTemp.find(c => c.id === conversationId);

        if (!conversation) {
          throw new Error('Conversation not found. It may have been deleted or is not synchronized.');
        }

        // Send the message
        await safeArrayBufferOperation(async () => await conversation.send(content.trim()), undefined);

        console.log('✅ Message sent successfully');

        // Trigger sync after sending to update messages
        setTimeout(() => {
          syncAll().catch(err => console.warn('Failed to sync after sending message:', err));
        }, 500);
      } catch (sendError) {
        console.error('❌ Failed to send message:', sendError);

        if (sendError instanceof Error) {
          if (sendError.message.includes('buffer') || sendError.message.includes('ArrayBuffer')) {
            throw new Error('Memory error detected. Please refresh the page and try again.');
          }

          if (sendError.message.includes('network') || sendError.message.includes('fetch')) {
            throw new Error('Network error. Please check your connection and try again.');
          }
        }

        const errorMessage = handleXMTPError(sendError, 'Failed to send message');
        throw new Error(errorMessage);
      }
    },
    [client, isReady],
  );

  /**
   * Start a new conversation with an address - ROBUST VERSION
   */
  const startConversation = useCallback(
    async (peerAddress: string): Promise<string> => {
      if (!client || !isReady || !isValidXMTPClient(client)) {
        throw new Error('Client not ready');
      }

      try {
        console.log('🆕 Starting conversation with:', peerAddress);

        const normalizedAddress = normalizeAddress(peerAddress);

        // 🔁 Obtenir l'inboxId depuis l'adresse Ethereum
        // Use client.findInboxIdByIdentifier and create an Identifier object
        const inboxIdLocal = await client.findInboxIdByIdentifier({
          identifier: normalizedAddress,
          identifierKind: 'Ethereum' as IdentifierKind, // Use IdentifierKind for type safety;
        });

        if (!inboxIdLocal) {
          throw new Error('This address is not registered with XMTP.');
        }

        // 🔄 Synchroniser les conversations
        await safeArrayBufferOperation(async () => await client.conversations.syncAll(), undefined);

        // 🔍 Rechercher une conversation existante
        const existingConversations = await client.conversations.list();

        for (const convo of existingConversations) {
          if (convo instanceof Dm) {
            try {
              const peerInboxId = await safeArrayBufferOperation(
                async () => await convo.peerInboxId(), // Use dmPeerInboxId for Dm instances
                null,
              );

              if (peerInboxId === inboxIdLocal) {
                console.log('✅ Using existing conversation');
                return convo.id;
              }
            } catch (peerError) {
              console.warn('Error checking peer for existing conversation:', peerError);
            }
          }
        }

        // ✉️ Créer une nouvelle conversation
        try {
          const newConversation = await safeArrayBufferOperation(async () => await client.conversations.newDm(inboxIdLocal), null);

          if (!newConversation) {
            throw new Error('Unable to create conversation. The address may not be registered with XMTP.');
          }

          console.log('✅ New conversation created:', newConversation.id);

          // 🔁 Rafraîchir la liste des conversations
          setTimeout(() => {
            loadConversations().catch(err => console.warn('Failed to reload conversations after creation:', err));
          }, 1000);

          return newConversation.id;
        } catch (createError: any) {
          console.error('❌ Failed to create conversation:', createError);

          if (
            createError.message?.includes('not found') ||
            createError.message?.includes('not registered') ||
            createError.message?.includes('identity')
          ) {
            throw new Error('This address is not registered with XMTP and cannot receive messages.');
          }

          if (createError.message?.includes('network') || createError.message?.includes('fetch')) {
            throw new Error('Network error. Please check your connection and try again.');
          }

          if (createError.message?.includes('buffer') || createError.message?.includes('ArrayBuffer')) {
            throw new Error('Memory error detected. Please refresh the page and try again.');
          }

          throw new Error(`Failed to create conversation: ${createError.message || 'Unknown error'}`);
        }
      } catch (convError) {
        const errorMessage = handleXMTPError(convError, 'Failed to start conversation');
        throw new Error(errorMessage);
      }
    },
    [client, isReady, getEthereumAddressFromInboxId, loadConversations],
  );

  /**
   * Get messages for a specific conversation
   */
  const getMessages = useCallback(
    async (conversationId: string, limit: number = 50): Promise<XMTPMessage[]> => {
      if (!client || !isReady || !isValidXMTPClient(client)) {
        return [];
      }

      try {
        console.log('📥 Getting messages for conversation:', conversationId);

        const conversationsTemps = await client.conversations.list();
        const conversation = conversationsTemps.find(c => c.id === conversationId);

        if (!conversation) {
          console.warn('Conversation not found:', conversationId);
          return [];
        }

        const messages = await safeArrayBufferOperation(
          async () =>
            await conversation.messages({
              limit: BigInt(limit),
              direction: 1,
            }),
          [],
        );

        const formattedMessages: XMTPMessage[] = await Promise.all(
          messages.map(async message => {
            const senderAddress = await getEthereumAddressFromInboxId(message.senderInboxId || '');

            return {
              id: message.id || `msg-${message.conversationId}-${message.sentAtNs}`,
              content: (message.content as string) || '[Unsupported Content]',
              senderAddress: senderAddress || message.senderInboxId || 'Unknown',
              sentAt: new Date(Number(message.sentAtNs) / 1_000_000),
              conversationId: message.conversationId || '',
            };
          }),
        );

        console.log(`✅ Retrieved ${formattedMessages.length} messages`);
        return formattedMessages.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
      } catch (msgError) {
        console.error('Failed to get messages:', msgError);
        return [];
      }
    },
    [client, isReady, getEthereumAddressFromInboxId],
  );

  /**
   * Stop message polling manually
   */
  const stopMessagePolling = useCallback((): void => {
    if (messagePollingIntervalRef.current) {
      clearInterval(messagePollingIntervalRef.current);
      messagePollingIntervalRef.current = null;
      setIsPolling(false);
      console.log('🛑 Message polling stopped');
    }
  }, []);

  /**
   * Start message polling and return cleanup function - FIXED VERSION
   */
  const streamAllMessages = useCallback(
    (onMessage: (message: XMTPMessage) => void): (() => void) => {
      if (!client || !isReady) {
        return () => {};
      }

      onMessageCallbackRef.current = onMessage;

      if (!isPolling) {
        setIsPolling(true);
        messagePollingIntervalRef.current = setInterval(pollForNewMessages, 3000);
      }

      // FIXED: Remove setIsPolling(false) from cleanup to avoid dependency loop
      return () => {
        onMessageCallbackRef.current = null;
        if (messagePollingIntervalRef.current) {
          clearInterval(messagePollingIntervalRef.current);
          messagePollingIntervalRef.current = null;
        }
        // Don't call setIsPolling(false) here - let stopMessagePolling handle it
      };
    },
    [client, isReady, pollForNewMessages], // Removed isPolling from dependencies
  );

  /**
   * Start conversation polling and return cleanup function
   */
  const streamConversations = useCallback(
    (onNewConversation: (conversation: XMTPConversation) => void): (() => void) => {
      if (!client || !isReady) {
        return () => {};
      }

      onNewConversationCallbackRef.current = onNewConversation;

      // Start polling for new conversations every 10 seconds
      conversationPollingIntervalRef.current = setInterval(async () => {
        try {
          await loadConversations();
        } catch (err) {
          console.warn('Error during conversation polling:', err);
        }
      }, 10000);

      return () => {
        onNewConversationCallbackRef.current = null;
        if (conversationPollingIntervalRef.current) {
          clearInterval(conversationPollingIntervalRef.current);
          conversationPollingIntervalRef.current = null;
        }
      };
    },
    [client, isReady, loadConversations],
  );

  /**
   * Sync all conversations and messages
   */
  const syncAll = useCallback(async (): Promise<void> => {
    if (!client || !isReady || !isValidXMTPClient(client)) {
      return;
    }

    try {
      console.log('🔄 Syncing all conversations...');
      await safeArrayBufferOperation(async () => await client.conversations.syncAll(), undefined);
      console.log('✅ Sync completed');
    } catch (syncError) {
      console.warn('Sync failed:', syncError);
    }
  }, [client, isReady]);

  /**
   * Start message polling manually
   */
  const startMessagePolling = useCallback((): void => {
    if (!isPolling && client && isReady) {
      setIsPolling(true);
      messagePollingIntervalRef.current = setInterval(pollForNewMessages, 3000);
      console.log('🚀 Message polling started');
    }
  }, [client, isReady, pollForNewMessages]); // Removed isPolling from dependencies

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupClient();
    };
  }, [cleanupClient]);

  return {
    // State
    client,
    inboxId,
    isReady,
    isInitializing,
    conversations,
    error,
    address,
    isConnected,
    isStreaming: isPolling,
    usePolling: true,

    // Actions
    initializeClient,
    loadConversations,
    canMessage,
    sendMessage,
    startConversation,
    getMessages,
    streamAllMessages,
    streamConversations,
    syncAll,
    startMessagePolling,
    stopMessagePolling,
  };
};
