
import { ILogger, ICollabService } from '../di/identifiers';
import { CollabService } from './CollabService';

export interface CursorPosition {
  row: number;
  col: number;
}

export interface SelectionRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface UserPresence {
  userId: string;
  username: string;
  avatar?: string;
  color: string;
  spreadsheetId: string;
  cursor?: CursorPosition;
  selection?: SelectionRange;
  lastActive: number;
}

export class PresenceService {
  // In-memory store: SpreadsheetID -> Map<UserID, UserPresence>
  private presenceMap = new Map<string, Map<string, UserPresence>>();
  
  // Assign consistent colors to users
  private userColors = new Map<string, string>();
  private readonly colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEEAD', 
    '#D4A5A5', '#9B59B6', '#3498DB', '#E74C3C', '#2ECC71'
  ];

  static inject = [ICollabService, ILogger];

  constructor(
    private collabService: CollabService,
    private logger: ILogger
  ) {
    this.setupSocketListeners();
  }

  private setupSocketListeners() {
    this.collabService.onConnection((socket) => {
      const userId = socket.handshake.query.userId as string || socket.id;
      const username = socket.handshake.query.username as string || `User ${userId.substring(0,4)}`;

      this.logger.info(`[Presence] User connected: ${userId}`);

      // Handle Join Sheet
      socket.on('presence:join', (spreadsheetId: string) => {
        this.addUser(spreadsheetId, {
          userId,
          username,
          color: this.getUserColor(userId),
          spreadsheetId,
          lastActive: Date.now()
        });
        
        // Broadcast to others in the sheet
        socket.to(`sheet:${spreadsheetId}`).emit('presence:update', this.getSheetUsers(spreadsheetId));
        // Send current list to self
        socket.emit('presence:update', this.getSheetUsers(spreadsheetId));
      });

      // Handle Cursor Move
      socket.on('presence:cursor', (data: { spreadsheetId: string, cursor: CursorPosition }) => {
        this.updateUser(data.spreadsheetId, userId, { cursor: data.cursor });
        socket.to(`sheet:${data.spreadsheetId}`).emit('presence:cursor', { userId, cursor: data.cursor });
      });

      // Handle Selection Change
      socket.on('presence:selection', (data: { spreadsheetId: string, selection: SelectionRange }) => {
        this.updateUser(data.spreadsheetId, userId, { selection: data.selection });
        socket.to(`sheet:${data.spreadsheetId}`).emit('presence:selection', { userId, selection: data.selection });
      });

      // Handle Leave/Disconnect
      socket.on('leave-sheet', (spreadsheetId: string) => {
        this.removeUser(spreadsheetId, userId);
        socket.to(`sheet:${spreadsheetId}`).emit('presence:update', this.getSheetUsers(spreadsheetId));
      });

      socket.on('disconnect', () => {
        this.handleDisconnect(userId);
      });
    });
  }

  private addUser(sheetId: string, user: UserPresence) {
    if (!this.presenceMap.has(sheetId)) {
      this.presenceMap.set(sheetId, new Map());
    }
    this.presenceMap.get(sheetId)!.set(user.userId, user);
  }

  private updateUser(sheetId: string, userId: string, update: Partial<UserPresence>) {
    const sheetUsers = this.presenceMap.get(sheetId);
    if (sheetUsers && sheetUsers.has(userId)) {
      const user = sheetUsers.get(userId)!;
      sheetUsers.set(userId, { ...user, ...update, lastActive: Date.now() });
    }
  }

  private removeUser(sheetId: string, userId: string) {
    const sheetUsers = this.presenceMap.get(sheetId);
    if (sheetUsers) {
      sheetUsers.delete(userId);
      if (sheetUsers.size === 0) {
        this.presenceMap.delete(sheetId);
      }
    }
  }

  private handleDisconnect(userId: string) {
    // Brute-force remove from all sheets (since we don't track User->Sheet reverse map efficiently yet)
    for (const [sheetId, users] of this.presenceMap.entries()) {
      if (users.has(userId)) {
        users.delete(userId);
        // Broadcast remove
        this.collabService.broadcast('presence:update', { spreadsheetId: sheetId, users: this.getSheetUsers(sheetId) });
      }
    }
  }

  private getSheetUsers(sheetId: string): UserPresence[] {
    const users = this.presenceMap.get(sheetId);
    return users ? Array.from(users.values()) : [];
  }

  private getUserColor(userId: string): string {
    if (!this.userColors.has(userId)) {
      const color = this.colors[this.userColors.size % this.colors.length];
      this.userColors.set(userId, color);
    }
    return this.userColors.get(userId)!;
  }
}
