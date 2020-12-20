import mongoose from 'mongoose';
import { withFilter } from 'apollo-server';

import { Resolvers } from '../generated-graphql';
import { pubSub } from '../apollo-server';
import { Subscriptions } from '../constants/Subscriptions';

const MessageResolver: Resolvers = {
  Query: {
    // Gets user's specific conversation
    getMessages: async (root, { authUserId, userId }, { Message }) => {
      const specificMessage = await Message.find()
        .and([
          { $or: [{ sender: authUserId }, { receiver: authUserId }] },
          { $or: [{ sender: userId }, { receiver: userId }] },
        ])
        .populate('sender')
        .populate('receiver')
        .sort({ updatedAt: 'asc' });

      return specificMessage;
    },
    // Get users with whom authUser had a conversation
    getConversations: async (root, { authUserId }, { User, Message }) => {
      // Get users with whom authUser had a chat
      const users = await User.findById(authUserId).populate('messages', 'id username fullName image isOnline');

      // Get last messages with whom authUser had a chat
      const lastMessages = await Message.aggregate([
        {
          $match: {
            $or: [
              {
                receiver: mongoose.Types.ObjectId(authUserId),
              },
              {
                sender: mongoose.Types.ObjectId(authUserId),
              },
            ],
          },
        },
        {
          $sort: { createdAt: -1 },
        },
        {
          $group: {
            _id: '$sender',
            doc: {
              $first: '$$ROOT',
            },
          },
        },
        { $replaceRoot: { newRoot: '$doc' } },
      ]);

      // Attach message properties to users
      interface UserConversation {
        id?: string;
        username?: string;
        fullName?: string;
        image?: string;
        isOnline?: boolean;
        seen?: boolean;
        lastMessageCreatedAt?: string;
        lastMessage?: string;
        lastMessageSender?: boolean;
      }

      const conversations = [];
      users.messages.map((u) => {
        const user: UserConversation = {};

        const sender = lastMessages.find((m) => u.id === m.sender.toString());
        if (sender) {
          user.seen = sender.seen;
          user.lastMessageCreatedAt = sender.createdAt;
          user.lastMessage = sender.message;
          user.lastMessageSender = false;
        } else {
          const receiver = lastMessages.find((m) => u.id === m.receiver.toString());
          if (receiver) {
            user.seen = receiver.seen;
            user.lastMessageCreatedAt = receiver.createdAt;
            user.lastMessage = receiver.message;
            user.lastMessageSender = true;
          }
        }

        conversations.push(user);
      });

      // Sort users by last created messages date
      const sortedConversations = conversations.sort((a, b) =>
        b.lastMessageCreatedAt.toString().localeCompare(a.lastMessageCreatedAt)
      );

      return sortedConversations;
    },
  },

  Mutation: {
    createMessage: async (root, { input: { message, sender, receiver } }, { Message, User }) => {
      let newMessage = await new Message({
        message,
        sender,
        receiver,
      }).save();

      newMessage = await newMessage.populate('sender').populate('receiver').execPopulate();

      pubSub.publish(Subscriptions.Message_Created, { messageCreated: newMessage });

      // Check if users already had a conversation, if not push their ids to users collection.
      const senderUser = await User.findById(sender);
      if (!senderUser.messages.includes(receiver)) {
        await User.findOneAndUpdate({ _id: sender }, { $push: { messages: receiver } });
        await User.findOneAndUpdate({ _id: receiver }, { $push: { messages: sender } });

        newMessage.isFirstMessage = true;
      }

      pubSub.publish(Subscriptions.New_Conversation, {
        newConversation: {
          receiverId: receiver,
          id: senderUser.id,
          username: senderUser.username,
          fullName: senderUser.fullName,
          image: senderUser.image,
          isOnline: senderUser.isOnline,
          seen: false,
          lastMessage: newMessage.message,
          lastMessageSender: false,
          lastMessageCreatedAt: newMessage.createdAt,
        },
      });

      return newMessage;
    },
    updateMessageSeen: async (root, { input: { sender, receiver } }, { Message }) => {
      try {
        await Message.update({ receiver, sender, seen: false }, { seen: true }, { multi: true });

        return true;
      } catch (e) {
        return false;
      }
    },
  },

  Subscription: {
    messageCreated: {
      subscribe: withFilter(
        () => pubSub.asyncIterator(Subscriptions.Message_Created),
        (payload, variables) => {
          const { sender, receiver } = payload.messageCreated;
          const { authUserId, userId } = variables;

          const isAuthUserSenderOrReceiver = authUserId === sender.id || authUserId === receiver.id;
          const isUserSenderOrReceiver = userId === sender.id || userId === receiver.id;

          return isAuthUserSenderOrReceiver && isUserSenderOrReceiver;
        }
      ),
    },
    newConversation: {
      subscribe: withFilter(
        () => pubSub.asyncIterator(Subscriptions.New_Conversation),
        (payload, variables, { authUserId }) => authUserId && authUserId === payload.newConversation.receiverId
      ),
    },
  },
};

export default MessageResolver;
