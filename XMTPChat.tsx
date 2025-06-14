import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Col,
  Row,
  Input,
  Form,
  Badge,
  Alert,
  Spinner,
  Modal,
  ModalHeader,
  ModalBody,
  ModalFooter,
} from 'reactstrap';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useXMTPService, XMTPConversation, XMTPMessage } from './hooks/useXMTPService';
import './style/XMTPChat.scss';

const XMTPChat: React.FC = () => {
  const {
    isReady,
    isInitializing,
    conversations,
    error,
    address,
    isConnected,
    isStreaming, // Maintenant isPolling
    inboxId,
    initializeClient,
    loadConversations,
    canMessage,
    sendMessage,
    startConversation,
    getMessages,
    streamAllMessages, // Utilise maintenant le polling
    streamConversations, // Nouvelle fonction pour les conversations
    syncAll,
    startMessagePolling,
    stopMessagePolling,
  } = useXMTPService();

  const [selectedConversation, setSelectedConversation] = useState<string | null>(null);
  const [messages, setMessages] = useState<XMTPMessage[]>([]);
  const [messageInput, setMessageInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // New conversation modal
  const [showNewConvoModal, setShowNewConvoModal] = useState(false);
  const [newConvoAddress, setNewConvoAddress] = useState('');
  const [isStartingConvo, setIsStartingConvo] = useState(false);
  const [addressValidation, setAddressValidation] = useState<{
    isValid: boolean;
    canReceive?: boolean;
    error?: string;
    isChecking?: boolean;
  }>({
    isValid: false,
  });

  // Refs pour le cleanup du polling
  const messagePollingCleanupRef = useRef<(() => void) | null>(null);
  const conversationPollingCleanupRef = useRef<(() => void) | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const validationTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Charger les conversations quand le client est prêt
  useEffect(() => {
    if (isReady && !isRefreshing) {
      setIsRefreshing(true);
      Promise.all([loadConversations(), syncAll()]).finally(() => {
        setIsRefreshing(false);
      });
    }
  }, [isReady, loadConversations, syncAll]);

  // Référence pour la conversation sélectionnée (pour éviter les redémarrages du polling)
  const selectedConversationRef = useRef<string | null>(null);
  const lastMessageTimestampRef = useRef<number>(0);

  // Mettre à jour la référence quand la conversation change
  useEffect(() => {
    selectedConversationRef.current = selectedConversation;
  }, [selectedConversation]);

  // Démarrer le polling des messages en temps réel quand prêt (UNE SEULE FOIS)
  useEffect(() => {
    if (isReady && !isStreaming) {
      console.log('🚀 Starting real-time message polling...');

      const initializeMessagePolling = () => {
        try {
          const cleanup = streamAllMessages((newMessage: XMTPMessage) => {
            console.log('📨 Received new message via polling:', newMessage);

            // Si le message est pour la conversation actuellement sélectionnée
            if (selectedConversationRef.current && newMessage.conversationId === selectedConversationRef.current) {
              setMessages(prevMessages => {
                // Éviter les doublons
                const messageExists = prevMessages.some(msg => msg.id === newMessage.id);
                if (messageExists) {
                  console.log('Message already exists, skipping duplicate');
                  return prevMessages;
                }

                console.log('Adding new message to current conversation');
                return [...prevMessages, newMessage].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
              });
            }

            // Recharger les conversations pour mettre à jour le dernier message
            loadConversations();
          });

          messagePollingCleanupRef.current = cleanup;
        } catch (pollingError) {
          console.error('Failed to start message polling:', pollingError);
        }
      };

      initializeMessagePolling();
    }

    // Cleanup du polling au démontage
    return () => {
      if (messagePollingCleanupRef.current) {
        console.log('🛑 Cleaning up message polling...');
        messagePollingCleanupRef.current();
        messagePollingCleanupRef.current = null;
      }
    };
  }, [isReady, isStreaming, streamAllMessages, loadConversations]); // Retiré selectedConversation des dépendances

  // Démarrer le polling des nouvelles conversations
  useEffect(() => {
    if (isReady) {
      console.log('🚀 Starting conversation polling...');

      const initializeConversationPolling = () => {
        try {
          const cleanup = streamConversations((newConversation: XMTPConversation) => {
            console.log('🆕 New conversation detected via polling:', newConversation);
            // Les conversations seront rechargées automatiquement
            loadConversations();
          });

          conversationPollingCleanupRef.current = cleanup;
        } catch (conversationPollingError) {
          console.error('Failed to start conversation polling:', conversationPollingError);
        }
      };

      initializeConversationPolling();
    }

    return () => {
      if (conversationPollingCleanupRef.current) {
        console.log('🛑 Cleaning up conversation polling...');
        conversationPollingCleanupRef.current();
        conversationPollingCleanupRef.current = null;
      }
    };
  }, [isReady, streamConversations, loadConversations]);

  // Charger les messages quand une conversation est sélectionnée
  useEffect(() => {
    if (selectedConversation && isReady) {
      loadMessagesForConversation(selectedConversation);
    }
  }, [selectedConversation, isReady]);

  // Auto-scroll vers le bas quand les messages changent
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  // Cleanup des timeouts au démontage
  useEffect(() => {
    return () => {
      if (validationTimeoutRef.current) {
        clearTimeout(validationTimeoutRef.current);
      }
    };
  }, []);

  const loadMessagesForConversation = useCallback(
    async (conversationId: string) => {
      setLoadingMessages(true);
      try {
        console.log('📥 Loading messages for conversation:', conversationId);
        const conversationMessages = await getMessages(conversationId);
        console.log(`✅ Loaded ${conversationMessages.length} messages`);

        // Trier les messages par date d'envoi
        const sortedMessages = conversationMessages.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());

        setMessages(sortedMessages);
      } catch (err) {
        console.error('❌ Failed to load messages:', err);
        setMessages([]); // Reset en cas d'erreur
      } finally {
        setLoadingMessages(false);
      }
    },
    [getMessages],
  );

  // Surveiller les changements dans les conversations pour recharger les messages de la conversation active
  useEffect(() => {
    if (!selectedConversation || !conversations.length) {
      return;
    }

    const currentConversation = conversations.find(c => c.id === selectedConversation);
    if (!currentConversation?.lastMessage) {
      return;
    }

    const lastMessageTimestamp = currentConversation.lastMessage.sentAt.getTime();

    // Si c'est un nouveau message pour la conversation active, recharger les messages
    if (lastMessageTimestamp > lastMessageTimestampRef.current) {
      console.log('📨 New message detected in active conversation, reloading messages...');
      lastMessageTimestampRef.current = lastMessageTimestamp;

      // Recharger les messages de la conversation active
      loadMessagesForConversation(selectedConversation).catch(err => {
        console.error('Failed to reload messages for active conversation:', err);
      });
    }
  }, [conversations, selectedConversation, loadMessagesForConversation]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!messageInput.trim() || !selectedConversation || isSending) return;

    const messageContent = messageInput.trim();
    setIsSending(true);
    setMessageInput(''); // Clear immédiatement pour une meilleure UX

    try {
      console.log('📤 Sending message:', messageContent);
      await sendMessage(selectedConversation, messageContent);
      console.log('✅ Message sent successfully');

      // Recharger les messages après un court délai pour laisser le temps au polling
      setTimeout(() => {
        loadMessagesForConversation(selectedConversation);
      }, 1000);
    } catch (err) {
      console.error('❌ Failed to send message:', err);
      // Restaurer le message en cas d'erreur
      setMessageInput(messageContent);
    } finally {
      setIsSending(false);
    }
  };

  // Validation d'adresse améliorée avec debouncing
  const validateAddress = useCallback(
    async (addressToValidate: string) => {
      if (!addressToValidate.trim()) {
        setAddressValidation({ isValid: false });
        return;
      }

      // Validation basique du format Ethereum
      const isValidFormat = /^0x[a-fA-F0-9]{40}$/.test(addressToValidate.trim());
      if (!isValidFormat) {
        setAddressValidation({
          isValid: false,
          error: 'Invalid Ethereum address format (must be 0x followed by 40 hex characters)',
        });
        return;
      }

      // Vérifier si c'est la même adresse que l'utilisateur
      if (addressToValidate.toLowerCase() === address?.toLowerCase()) {
        setAddressValidation({
          isValid: false,
          error: 'You cannot send messages to yourself',
        });
        return;
      }

      setAddressValidation({ isValid: true, isChecking: true });

      try {
        console.log('🔍 Checking if address can receive XMTP messages:', addressToValidate);
        const canMessageResponse = await canMessage([addressToValidate.trim()]);
        const canReceive = canMessageResponse.get(addressToValidate.trim().toLowerCase()) || false;
        console.log('✅ Address compatibility check result:', canReceive);
        console.log('---------  >Address validation complete:', addressToValidate.trim());

        setAddressValidation({
          isValid: true,
          canReceive,
          error: canReceive ? undefined : 'This address is not registered with XMTP and cannot receive messages',
          isChecking: false,
        });
      } catch (err) {
        console.error('❌ Failed to check address compatibility:', err);
        setAddressValidation({
          isValid: false,
          error: 'Failed to check address compatibility. Please try again.',
          isChecking: false,
        });
      }
    },
    [canMessage, address],
  );

  // Gérer le changement d'adresse avec debouncing
  const handleAddressChange = useCallback(
    (value: string) => {
      setNewConvoAddress(value);

      // Clear previous timeout
      if (validationTimeoutRef.current) {
        clearTimeout(validationTimeoutRef.current);
      }

      if (value.trim()) {
        // Debounce la validation à 800ms
        validationTimeoutRef.current = setTimeout(() => {
          validateAddress(value);
        }, 800);
      } else {
        setAddressValidation({ isValid: false });
      }
    },
    [validateAddress],
  );

  const handleStartNewConversation = async () => {
    if (!newConvoAddress.trim() || isStartingConvo || !addressValidation.canReceive) return;

    setIsStartingConvo(true);
    try {
      console.log('🆕 Starting new conversation with:', newConvoAddress.trim());
      const conversationId = await startConversation(newConvoAddress.trim());
      console.log('✅ New conversation started:', conversationId);

      // Sélectionner la nouvelle conversation
      setSelectedConversation(conversationId);

      // Fermer le modal et reset
      setShowNewConvoModal(false);
      setNewConvoAddress('');
      setAddressValidation({ isValid: false });

      // Recharger les conversations
      setTimeout(() => {
        loadConversations();
      }, 1000);
    } catch (err) {
      console.error('❌ Failed to start conversation:', err);
    } finally {
      setIsStartingConvo(false);
    }
  };

  const handleRefresh = async () => {
    if (isRefreshing) return;

    setIsRefreshing(true);
    try {
      await Promise.all([
        syncAll(),
        loadConversations(),
        selectedConversation ? loadMessagesForConversation(selectedConversation) : Promise.resolve(),
      ]);
    } catch (err) {
      console.error('❌ Failed to refresh:', err);
    } finally {
      setIsRefreshing(false);
    }
  };

  // Fonction utilitaire pour nettoyer et valider le contenu des messages
  const sanitizeMessageContent = (content: any): string => {
    if (typeof content === 'string') {
      return content;
    }

    if (typeof content === 'object' && content !== null) {
      // Si c'est un objet, essayer d'extraire le contenu textuel
      if (content.text) {
        return content.text;
      }
      if (content.content) {
        return content.content;
      }
      // Si c'est un objet complexe, le convertir en JSON lisible
      try {
        return JSON.stringify(content, null, 2);
      } catch {
        return '[Complex message content]';
      }
    }

    // Pour tous les autres types, convertir en string
    return String(content || '');
  };

  // Utilitaires de formatage
  const formatAddress = (addr: string) => {
    if (!addr) return '';
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  const formatTime = (date: Date) => {
    return new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(date);
  };

  const formatDate = (date: Date) => {
    const now = new Date();
    const diffInHours = (now.getTime() - date.getTime()) / (1000 * 60 * 60);

    if (diffInHours < 24) {
      return formatTime(date);
    } else if (diffInHours < 48) {
      return 'Yesterday';
    } else {
      return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
      }).format(date);
    }
  };

  // Pas connecté au wallet
  if (!isConnected) {
    return (
      <Card className="xmtp-chat">
        <CardBody className="text-center">
          <i className="fa fa-wallet fa-3x text-muted mb-3"></i>
          <h5>Connect Your Wallet</h5>
          <p className="text-muted">Please connect your wallet to start using XMTP decentralized messaging.</p>
          <small className="text-muted">XMTP enables secure, decentralized messaging between Ethereum addresses.</small>
        </CardBody>
      </Card>
    );
  }

  // Initialisation en cours
  if (isInitializing) {
    return (
      <Card className="xmtp-chat">
        <CardBody className="text-center">
          <Spinner color="primary" className="mb-3" />
          <h5>Initializing XMTP</h5>
          <p className="text-muted">Setting up your decentralized messaging client...</p>
          <small className="text-muted">This may take a few moments.</small>
        </CardBody>
      </Card>
    );
  }

  // État d'erreur
  if (error) {
    return (
      <Card className="xmtp-chat">
        <CardBody>
          <Alert color="danger">
            <strong>XMTP Error:</strong> {error}
          </Alert>
          <div className="d-flex gap-2">
            <Button color="primary" onClick={initializeClient}>
              <i className="fa fa-refresh me-2"></i>
              Try Again
            </Button>
            <Button color="outline-secondary" onClick={() => window.location.reload()}>
              <i className="fa fa-redo me-2"></i>
              Reload Page
            </Button>
          </div>
        </CardBody>
      </Card>
    );
  }

  // Pas prêt
  if (!isReady) {
    return (
      <Card className="xmtp-chat">
        <CardBody className="text-center">
          <i className="fa fa-comments fa-3x text-muted mb-3"></i>
          <h5>XMTP Messaging</h5>
          <p className="text-muted mb-3">Enable secure, decentralized messaging</p>
          <Button color="primary" size="lg" onClick={initializeClient}>
            <i className="fa fa-play me-2"></i>
            Initialize XMTP
          </Button>
          <small className="d-block text-muted mt-2">Connected as: {formatAddress(address || '')}</small>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="xmtp-chat-layout">
      <Row className="h-100">
        {/* Sidebar des conversations */}
        <Col md="4" className="conversations-sidebar">
          <Card className="h-100">
            <CardHeader className="d-flex justify-content-between align-items-center">
              <div>
                <h6 className="mb-0">
                  <i className="fa fa-comments me-2"></i>
                  Conversations
                </h6>
                <small className="text-muted">
                  {isStreaming && <i className="fa fa-circle text-success me-1"></i>}
                  {formatAddress(address || '')}
                </small>
              </div>
              <div>
                <Button
                  color="outline-secondary"
                  size="sm"
                  onClick={handleRefresh}
                  disabled={isRefreshing}
                  className="me-2"
                  title="Refresh conversations"
                >
                  <i className={`fa fa-refresh ${isRefreshing ? 'fa-spin' : ''} me-1`}></i>
                  {isRefreshing ? 'Refreshing...' : 'Refresh'}
                </Button>
                <Button color="primary" size="sm" onClick={() => setShowNewConvoModal(true)} title="Start new conversation">
                  <i className="fa fa-plus me-1"></i>
                  New Chat
                </Button>
              </div>
            </CardHeader>
            <CardBody className="p-0">
              {conversations.length === 0 ? (
                <div className="text-center p-4">
                  <i className="fa fa-comment-slash fa-2x text-muted mb-2"></i>
                  <p className="text-muted mb-3">No conversations yet</p>
                  <Button color="outline-primary" size="sm" onClick={() => setShowNewConvoModal(true)}>
                    <i className="fa fa-plus me-2"></i>
                    Start First Conversation
                  </Button>
                </div>
              ) : (
                <div className="conversation-list">
                  {conversations.map(convo => (
                    <div
                      key={convo.id}
                      className={`conversation-item ${selectedConversation === convo.id ? 'active' : ''}`}
                      onClick={() => setSelectedConversation(convo.id)}
                    >
                      <div className="conversation-header">
                        <strong>{formatAddress(convo.peerAddress)}</strong>
                        <small className="text-muted">
                          {convo.lastMessage ? formatDate(convo.lastMessage.sentAt) : formatDate(convo.createdAt)}
                        </small>
                      </div>
                      {convo.lastMessage && (
                        <div className="conversation-preview">
                          <small className="text-muted">
                            {(() => {
                              // Même logique de normalisation pour la liste des conversations
                              const normalizedSender = convo.lastMessage.senderAddress?.toLowerCase();
                              const normalizedUserAddress = address?.toLowerCase();
                              const normalizedInboxId = inboxId?.toLowerCase();
                              const isMessageSent = normalizedSender === normalizedUserAddress || normalizedSender === normalizedInboxId;

                              // Nettoyer le contenu du message pour l'aperçu
                              const messageContent = sanitizeMessageContent(convo.lastMessage.content);

                              return (
                                <>
                                  {isMessageSent && <i className="fa fa-reply me-1 text-primary"></i>}
                                  {messageContent.substring(0, 50)}
                                  {messageContent.length > 50 ? '...' : ''}
                                </>
                              );
                            })()}
                          </small>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        </Col>

        {/* Zone des messages */}
        <Col md="8" className="messages-area">
          <Card className="h-100">
            {selectedConversation ? (
              <>
                <CardHeader className="d-flex justify-content-between align-items-center">
                  <h6 className="mb-0">
                    <i className="fa fa-user me-2"></i>
                    {(() => {
                      const conversation = conversations.find(c => c.id === selectedConversation);
                      return conversation ? formatAddress(conversation.peerAddress) : 'Unknown';
                    })()}
                  </h6>
                  <small className="text-muted">
                    {isStreaming && (
                      <>
                        <i className="fa fa-circle text-success me-1"></i>
                        Live updates active
                      </>
                    )}
                  </small>
                </CardHeader>
                <CardBody className="messages-container">
                  {loadingMessages ? (
                    <div className="text-center">
                      <Spinner color="primary" size="sm" />
                      <span className="ms-2">Loading messages...</span>
                    </div>
                  ) : (
                    <div className="messages-list">
                      {messages.length === 0 ? (
                        <div className="text-center p-4">
                          <i className="fa fa-comment fa-2x text-muted mb-2"></i>
                          <p className="text-muted">No messages yet. Start the conversation!</p>
                        </div>
                      ) : (
                        messages.map(message => {
                          // Logique simple qui fonctionnait avant
                          const normalizedSender = message.senderAddress?.toLowerCase();
                          const normalizedUserAddress = address?.toLowerCase();
                          const normalizedInboxId = inboxId?.toLowerCase();

                          // Vérification simple qui marchait
                          const isMessageSent = normalizedSender === normalizedUserAddress || normalizedSender === normalizedInboxId;

                          // Nettoyer le contenu du message
                          const messageContent = sanitizeMessageContent(message.content);

                          return (
                            <div key={message.id} className={`message ${isMessageSent ? 'message-sent' : 'message-received'}`}>
                              <div className="message-content">{messageContent}</div>
                              <div className="message-time">
                                {formatTime(message.sentAt)}
                                {isMessageSent && <i className="fa fa-check ms-1 text-success"></i>}
                              </div>
                            </div>
                          );
                        })
                      )}
                      <div ref={messagesEndRef} />
                    </div>
                  )}
                </CardBody>
                <div className="message-input-area">
                  <Form onSubmit={handleSendMessage} className="d-flex p-3">
                    <Input
                      type="text"
                      placeholder="Type your message..."
                      value={messageInput}
                      onChange={e => setMessageInput(e.target.value)}
                      disabled={isSending}
                      className="me-2"
                      maxLength={1000}
                    />
                    <Button type="submit" color="primary" disabled={!messageInput.trim() || isSending} className="px-3">
                      {isSending ? (
                        <>
                          <Spinner size="sm" className="me-1" />
                          Sending...
                        </>
                      ) : (
                        <>
                          <i className="fa fa-paper-plane me-1"></i>
                          Send
                        </>
                      )}
                    </Button>
                  </Form>
                </div>
              </>
            ) : (
              <CardBody className="text-center">
                <i className="fa fa-comment-dots fa-3x text-muted mb-3"></i>
                <h5>Select a Conversation</h5>
                <p className="text-muted mb-3">Choose a conversation from the sidebar or start a new one.</p>
                <Button color="primary" onClick={() => setShowNewConvoModal(true)}>
                  <i className="fa fa-plus me-2"></i>
                  Start New Conversation
                </Button>
              </CardBody>
            )}
          </Card>
        </Col>
      </Row>

      {/* Modal pour nouvelle conversation */}
      <Modal isOpen={showNewConvoModal} toggle={() => setShowNewConvoModal(false)} size="md">
        <ModalHeader toggle={() => setShowNewConvoModal(false)}>
          <i className="fa fa-plus me-2"></i>
          Start New Conversation
        </ModalHeader>
        <ModalBody>
          <Form
            onSubmit={e => {
              e.preventDefault();
              handleStartNewConversation();
            }}
          >
            <div className="mb-3">
              <label htmlFor="newConvoAddress" className="form-label">
                <strong>Recipient Ethereum Address</strong>
              </label>
              <Input
                id="newConvoAddress"
                type="text"
                placeholder="0x1234567890abcdef..."
                value={newConvoAddress}
                onChange={e => handleAddressChange(e.target.value)}
                disabled={isStartingConvo}
                valid={addressValidation.isValid && addressValidation.canReceive}
                invalid={addressValidation.isValid && Boolean(addressValidation.error)}
              />

              {/* États de validation */}
              {addressValidation.isChecking && (
                <small className="text-info">
                  <Spinner size="sm" className="me-1" />
                  Checking address compatibility...
                </small>
              )}

              {addressValidation.error && (
                <small className="text-danger">
                  <i className="fa fa-exclamation-triangle me-1"></i>
                  {addressValidation.error}
                </small>
              )}

              {addressValidation.canReceive && (
                <small className="text-success">
                  <i className="fa fa-check me-1"></i>
                  This address can receive XMTP messages
                </small>
              )}

              {!addressValidation.error && !addressValidation.canReceive && !addressValidation.isChecking && (
                <small className="text-muted">Enter the Ethereum address of the person you want to message.</small>
              )}
            </div>
          </Form>
        </ModalBody>
        <ModalFooter>
          <Button
            color="secondary"
            onClick={() => {
              setShowNewConvoModal(false);
              setNewConvoAddress('');
              setAddressValidation({ isValid: false });
            }}
            disabled={isStartingConvo}
          >
            Cancel
          </Button>
          <Button
            color="primary"
            onClick={handleStartNewConversation}
            disabled={!addressValidation.canReceive || isStartingConvo || addressValidation.isChecking}
          >
            {isStartingConvo ? (
              <>
                <Spinner size="sm" className="me-2" />
                Starting...
              </>
            ) : (
              <>
                <i className="fa fa-comment me-2"></i>
                Start Conversation
              </>
            )}
          </Button>
        </ModalFooter>
      </Modal>
    </div>
  );
};

export default XMTPChat;
