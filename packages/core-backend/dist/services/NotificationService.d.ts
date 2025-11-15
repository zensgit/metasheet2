/**
 * 通知服务实现
 * 支持多渠道通知发送，模板管理，订阅管理
 */
import { EventEmitter } from 'eventemitter3';
import type { NotificationService, Notification, NotificationResult, NotificationRecipient, NotificationChannel, NotificationTemplate, NotificationHistory, NotificationHistoryOptions, NotificationSubscription, NotificationPreferences } from '../types/plugin';
/**
 * 邮件通知渠道
 */
export declare class EmailNotificationChannel implements NotificationChannel {
    name: string;
    type: "email";
    config: any;
    private logger;
    constructor(config: any);
    sender(notification: Notification, recipients: NotificationRecipient[]): Promise<NotificationResult>;
    private sendEmail;
}
/**
 * Webhook 通知渠道
 */
export declare class WebhookNotificationChannel implements NotificationChannel {
    name: string;
    type: "webhook";
    config: any;
    private logger;
    constructor(config: any);
    sender(notification: Notification, recipients: NotificationRecipient[]): Promise<NotificationResult>;
    private sendWebhook;
}
/**
 * 飞书通知渠道
 */
export declare class FeishuNotificationChannel implements NotificationChannel {
    name: string;
    type: "feishu";
    config: any;
    private logger;
    constructor(config: any);
    sender(notification: Notification, recipients: NotificationRecipient[]): Promise<NotificationResult>;
    private sendFeishuMessage;
}
/**
 * 通知服务实现
 */
export declare class NotificationServiceImpl extends EventEmitter implements NotificationService {
    private channels;
    private templates;
    private history;
    private subscriptions;
    private logger;
    constructor();
    send(notification: Notification): Promise<NotificationResult>;
    sendBatch(notifications: Notification[]): Promise<NotificationResult[]>;
    sendTemplate(templateName: string, recipients: NotificationRecipient[], data: any): Promise<NotificationResult>;
    registerChannel(channel: NotificationChannel): void;
    getChannels(): NotificationChannel[];
    registerTemplate(template: NotificationTemplate): void;
    getTemplate(name: string): NotificationTemplate | null;
    getHistory(options?: NotificationHistoryOptions): Promise<NotificationHistory[]>;
    subscribe(userId: string, channel: string, preferences: NotificationPreferences): Promise<void>;
    unsubscribe(userId: string, channel: string): Promise<void>;
    getSubscriptions(userId: string): Promise<NotificationSubscription[]>;
    private filterRecipientsByPreferences;
    private isInQuietHours;
    private scheduleNotification;
    private renderTemplate;
    private addToHistory;
    /**
     * 获取服务统计信息
     */
    getStats(): {
        channels: number;
        templates: number;
        historySize: number;
        subscriptions: number;
    };
    /**
     * 清理历史记录
     */
    cleanHistory(beforeDate: Date): void;
}
//# sourceMappingURL=NotificationService.d.ts.map