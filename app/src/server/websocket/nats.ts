import { connect, consumerOpts, JSONCodec, Subscription, JetStreamClient } from 'nats';
import { updateDB } from './webSocket';
import { FASTAGENCY_SERVER_URL } from '../common/constants';

function generateNatsUrl(natsUrl: string | undefined, fastAgencyServerUrl: string | undefined): string | undefined {
  if (natsUrl) return natsUrl;
  return fastAgencyServerUrl ? `${fastAgencyServerUrl.replace('https://', 'tls://')}:4222` : fastAgencyServerUrl;
}

const NATS_URL = generateNatsUrl(process.env['NATS_URL'], FASTAGENCY_SERVER_URL);
console.log(`NATS_URL=${NATS_URL}`);

class NatsConnectionManager {
  public static connections: Map<
    string,
    {
      nc: any;
      subscriptions: Map<string, Subscription>;
      socketConversationHistory: string;
      lastSocketMessage: string | null;
      conversationId: number;
    }
  > = new Map();

  static async getConnection(threadId: string, conversationId: number) {
    if (!this.connections.has(threadId)) {
      const nc = await connect({ servers: NATS_URL });
      this.connections.set(threadId, {
        nc,
        subscriptions: new Map(),
        socketConversationHistory: '',
        lastSocketMessage: null,
        conversationId: conversationId,
      });
      console.log(`Connected to ${nc.getServer()} for threadId ${threadId}`);
    }
    return this.connections.get(threadId);
  }

  static async cleanup(threadId: string) {
    const connection = this.connections.get(threadId);
    if (connection) {
      for (const sub of connection.subscriptions.values()) {
        await sub.unsubscribe();
      }
      await connection.nc.close();
      this.connections.delete(threadId);
      console.log(`Cleaned up NATS connection and subscriptions for threadId ${threadId}`);
    }
  }

  static addSubscription(threadId: string, subject: string, sub: Subscription) {
    const connection = this.connections.get(threadId);
    connection && connection.subscriptions.set(subject, sub);
  }

  static updateMessageHistory(threadId: string, message: string) {
    const connection = this.connections.get(threadId);
    if (connection) {
      connection.lastSocketMessage = message;
      connection.socketConversationHistory += message;
    }
  }

  static getLastSocketMessage(threadId: string): string | null | undefined {
    return this.connections.get(threadId)?.lastSocketMessage;
  }

  static getConversationHistory(threadId: string): string {
    return this.connections.get(threadId)?.socketConversationHistory || '';
  }

  static getConversationId(threadId: string): number | null {
    return this.connections.get(threadId)?.conversationId || null;
  }

  static setConversationId(threadId: string, conversationId: number) {
    const connection = this.connections.get(threadId);
    if (connection) {
      connection.conversationId = conversationId;
    }
  }

  static clearConversationHistory(threadId: string) {
    const connection = this.connections.get(threadId);
    if (connection) {
      connection.socketConversationHistory = '';
    }
  }
}

async function setupSubscription(
  js: JetStreamClient,
  jc: any,
  subject: string,
  threadId: string,
  socket: any,
  context?: any,
  currentChatDetails?: any
) {
  const opts = consumerOpts();
  opts.orderedConsumer();
  let sub = null;
  try {
    sub = await js.subscribe(subject, opts);
    NatsConnectionManager.addSubscription(threadId, subject, sub as Subscription);
  } catch (err) {
    console.error(`Error in subscribe for ${subject}: ${err}`);
    return;
  }
  (async () => {
    for await (const m of sub) {
      const conversationHistory = NatsConnectionManager.getConversationHistory(threadId);
      const conversationId = NatsConnectionManager.getConversationId(threadId);
      const jm = jc.decode(m.data);
      const type = jm.type;
      let message = jm.data.msg || jm.data.prompt;
      // console.log(`Received ${type} message: `, message);
      if (type === 'print') {
        NatsConnectionManager.updateMessageHistory(threadId, message);
        socket.emit('newMessageFromTeam', conversationHistory);
      } else {
        try {
          const isChatTerminated = type === 'terminate' || type === 'error';
          message =
            type === 'error'
              ? `${message}\n\nUnfortunately, you won't be able to continue this chat. Could you please create a new chat and give it another try? Thanks!`
              : message;
          await updateDB(
            context,
            currentChatDetails.id,
            message,
            conversationId,
            conversationHistory,
            isChatTerminated
          );
          if (isChatTerminated) {
            console.log('Terminating chat and cleaning up NATS connection and subscriptions.');
            NatsConnectionManager.cleanup(threadId);
          }
        } catch (err) {
          console.error(`DB Update failed: ${err}`);
        } finally {
          socket.emit('streamFromTeamFinished');
        }
      }
    }
  })().catch((err) => {
    console.error(`Error in subscription for ${subject}: ${err}`);
  });
}

export async function sendMsgToNatsServer(
  socket: any,
  context: any,
  currentChatDetails: any,
  selectedTeamUUID: string,
  userUUID: string,
  message: string,
  conversationId: number,
  shouldCallInitiateChat: boolean
) {
  try {
    const threadId = currentChatDetails.uuid;
    const { nc } = (await NatsConnectionManager.getConnection(threadId, conversationId)) as { nc: any };
    const js = nc.jetstream();
    const jc = JSONCodec();

    // Initiate chat or continue conversation
    const initiateChatSubject = `chat.server.initiate_chat`;
    const serverInputSubject = `chat.server.messages.${threadId}`;
    const subject = shouldCallInitiateChat ? initiateChatSubject : serverInputSubject;

    NatsConnectionManager.clearConversationHistory(threadId);
    const payload = { user_id: userUUID, thread_id: threadId, team_id: selectedTeamUUID, msg: message };
    console.log('-----------');
    console.log(selectedTeamUUID);
    console.log(payload);
    console.log('-----------');
    await js.publish(subject, jc.encode(payload));

    if (shouldCallInitiateChat) {
      const clientInputSubject = `chat.client.messages.${threadId}`;
      await setupSubscription(js, jc, clientInputSubject, threadId, socket, context, currentChatDetails);
    } else {
      NatsConnectionManager.setConversationId(threadId, conversationId);
    }
  } catch (err) {
    console.error(`Error in connectToNatsServer: ${err}`);
  }
}
