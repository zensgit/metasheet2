"use strict";
/**
 * 通知服务实现
 * 支持多渠道通知发送，模板管理，订阅管理
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationServiceImpl = exports.FeishuNotificationChannel = exports.WebhookNotificationChannel = exports.EmailNotificationChannel = void 0;
const eventemitter3_1 = require("eventemitter3");
const logger_1 = require("../core/logger");
/**
 * 邮件通知渠道
 */
class EmailNotificationChannel {
    name = 'email';
    type = 'email';
    config;
    logger;
    constructor(config) {
        this.config = config;
        this.logger = new logger_1.Logger('EmailChannel');
    }
    async sender(notification, recipients) {
        const id = `email_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        try {
            // 这里应该集成实际的邮件服务(如 SendGrid, SES, SMTP)
            const emailRecipients = recipients.filter(r => r.type === 'email');
            for (const recipient of emailRecipients) {
                await this.sendEmail({
                    to: recipient.id,
                    subject: notification.subject,
                    content: notification.content,
                    metadata: notification.metadata
                });
            }
            return {
                id,
                status: 'sent',
                sentAt: new Date(),
                metadata: {
                    channel: 'email',
                    recipientCount: emailRecipients.length
                }
            };
        }
        catch (error) {
            this.logger.error('Failed to send email notification', error);
            return {
                id,
                status: 'failed',
                failedReason: error.message,
                metadata: {
                    channel: 'email'
                }
            };
        }
    }
    async sendEmail(params) {
        // 实际邮件发送实现
        this.logger.info(`Sending email to ${params.to}: ${params.subject}`);
        // 模拟异步发送
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}
exports.EmailNotificationChannel = EmailNotificationChannel;
/**
 * Webhook 通知渠道
 */
class WebhookNotificationChannel {
    name = 'webhook';
    type = 'webhook';
    config;
    logger;
    constructor(config) {
        this.config = config;
        this.logger = new logger_1.Logger('WebhookChannel');
    }
    async sender(notification, recipients) {
        const id = `webhook_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        try {
            const webhookRecipients = recipients.filter(r => r.type === 'webhook');
            for (const recipient of webhookRecipients) {
                await this.sendWebhook(recipient.id, {
                    subject: notification.subject,
                    content: notification.content,
                    data: notification.data,
                    metadata: notification.metadata
                });
            }
            return {
                id,
                status: 'sent',
                sentAt: new Date(),
                metadata: {
                    channel: 'webhook',
                    recipientCount: webhookRecipients.length
                }
            };
        }
        catch (error) {
            this.logger.error('Failed to send webhook notification', error);
            return {
                id,
                status: 'failed',
                failedReason: error.message,
                metadata: {
                    channel: 'webhook'
                }
            };
        }
    }
    async sendWebhook(url, payload) {
        // 实际 HTTP 请求实现
        this.logger.info(`Sending webhook to ${url}`);
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'MetaSheet-Notification-Service/1.0'
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(10000) // 10秒超时
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
        }
        catch (error) {
            this.logger.error(`Webhook delivery failed for ${url}`, error);
            throw error;
        }
    }
}
exports.WebhookNotificationChannel = WebhookNotificationChannel;
/**
 * 飞书通知渠道
 */
class FeishuNotificationChannel {
    name = 'feishu';
    type = 'feishu';
    config;
    logger;
    constructor(config) {
        this.config = config;
        this.logger = new logger_1.Logger('FeishuChannel');
    }
    async sender(notification, recipients) {
        const id = `feishu_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        try {
            // 集成飞书 API
            const userRecipients = recipients.filter(r => r.type === 'user');
            for (const recipient of userRecipients) {
                await this.sendFeishuMessage(recipient.id, {
                    title: notification.subject,
                    content: notification.content,
                    data: notification.data
                });
            }
            return {
                id,
                status: 'sent',
                sentAt: new Date(),
                metadata: {
                    channel: 'feishu',
                    recipientCount: userRecipients.length
                }
            };
        }
        catch (error) {
            this.logger.error('Failed to send feishu notification', error);
            return {
                id,
                status: 'failed',
                failedReason: error.message,
                metadata: {
                    channel: 'feishu'
                }
            };
        }
    }
    async sendFeishuMessage(userId, message) {
        // 实际飞书消息发送实现
        this.logger.info(`Sending feishu message to user ${userId}`);
        // 模拟异步发送
        await new Promise(resolve => setTimeout(resolve, 150));
    }
}
exports.FeishuNotificationChannel = FeishuNotificationChannel;
/**
 * 通知服务实现
 */
class NotificationServiceImpl extends eventemitter3_1.EventEmitter {
    channels = new Map();
    templates = new Map();
    history = [];
    subscriptions = new Map();
    logger;
    constructor() {
        super();
        this.logger = new logger_1.Logger('NotificationService');
        // 注册默认通知渠道
        this.registerChannel(new EmailNotificationChannel({}));
        this.registerChannel(new WebhookNotificationChannel({}));
        this.registerChannel(new FeishuNotificationChannel({}));
    }
    async send(notification) {
        try {
            const channel = this.channels.get(notification.channel);
            if (!channel) {
                throw new Error(`Unknown notification channel: ${notification.channel}`);
            }
            // 过滤收件人的通知偏好
            const filteredRecipients = await this.filterRecipientsByPreferences(notification.recipients, notification.channel);
            if (filteredRecipients.length === 0) {
                const result = {
                    id: `skip_${Date.now()}`,
                    status: 'cancelled',
                    metadata: {
                        reason: 'No recipients after preference filtering'
                    }
                };
                this.addToHistory({
                    id: result.id,
                    notification,
                    result,
                    createdAt: new Date()
                });
                return result;
            }
            // 检查是否需要延迟发送
            if (notification.scheduledAt && notification.scheduledAt > new Date()) {
                return this.scheduleNotification(notification, filteredRecipients);
            }
            // 立即发送
            const result = await channel.sender(notification, filteredRecipients);
            // 记录历史
            this.addToHistory({
                id: result.id,
                notification: { ...notification, recipients: filteredRecipients },
                result,
                createdAt: new Date()
            });
            this.emit('notification:sent', { notification, result });
            return result;
        }
        catch (error) {
            this.logger.error('Failed to send notification', error);
            const result = {
                id: `error_${Date.now()}`,
                status: 'failed',
                failedReason: error.message
            };
            this.addToHistory({
                id: result.id,
                notification,
                result,
                createdAt: new Date()
            });
            this.emit('notification:error', { notification, error });
            return result;
        }
    }
    async sendBatch(notifications) {
        const results = [];
        for (const notification of notifications) {
            try {
                const result = await this.send(notification);
                results.push(result);
            }
            catch (error) {
                results.push({
                    id: `batch_error_${Date.now()}`,
                    status: 'failed',
                    failedReason: error.message
                });
            }
        }
        this.emit('notification:batch:sent', { notifications, results });
        return results;
    }
    async sendTemplate(templateName, recipients, data) {
        const template = this.templates.get(templateName);
        if (!template) {
            throw new Error(`Unknown notification template: ${templateName}`);
        }
        // 渲染模板
        const subject = this.renderTemplate(template.subject, data);
        const content = this.renderTemplate(template.content, data);
        const notification = {
            channel: template.channel,
            recipients,
            subject,
            content,
            data,
            metadata: {
                template: templateName,
                ...template.metadata
            }
        };
        return this.send(notification);
    }
    registerChannel(channel) {
        this.channels.set(channel.name, channel);
        this.logger.info(`Registered notification channel: ${channel.name}`);
    }
    getChannels() {
        return Array.from(this.channels.values());
    }
    registerTemplate(template) {
        this.templates.set(template.name, template);
        this.logger.info(`Registered notification template: ${template.name}`);
    }
    getTemplate(name) {
        return this.templates.get(name) || null;
    }
    async getHistory(options = {}) {
        let filtered = [...this.history];
        if (options.userId) {
            filtered = filtered.filter(h => h.notification.recipients.some(r => r.id === options.userId));
        }
        if (options.channel) {
            filtered = filtered.filter(h => h.notification.channel === options.channel);
        }
        if (options.status) {
            filtered = filtered.filter(h => h.result.status === options.status);
        }
        if (options.dateFrom) {
            filtered = filtered.filter(h => h.createdAt >= options.dateFrom);
        }
        if (options.dateTo) {
            filtered = filtered.filter(h => h.createdAt <= options.dateTo);
        }
        // 分页
        const offset = options.offset || 0;
        const limit = options.limit || 100;
        return filtered
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(offset, offset + limit);
    }
    async subscribe(userId, channel, preferences) {
        const userSubscriptions = this.subscriptions.get(userId) || [];
        // 移除已存在的同渠道订阅
        const filtered = userSubscriptions.filter(s => s.channel !== channel);
        // 添加新订阅
        const subscription = {
            userId,
            channel,
            preferences,
            createdAt: new Date(),
            updatedAt: new Date()
        };
        filtered.push(subscription);
        this.subscriptions.set(userId, filtered);
        this.emit('notification:subscribed', { userId, channel, preferences });
        this.logger.info(`User ${userId} subscribed to ${channel} channel`);
    }
    async unsubscribe(userId, channel) {
        const userSubscriptions = this.subscriptions.get(userId) || [];
        const filtered = userSubscriptions.filter(s => s.channel !== channel);
        if (filtered.length !== userSubscriptions.length) {
            this.subscriptions.set(userId, filtered);
            this.emit('notification:unsubscribed', { userId, channel });
            this.logger.info(`User ${userId} unsubscribed from ${channel} channel`);
        }
    }
    async getSubscriptions(userId) {
        return this.subscriptions.get(userId) || [];
    }
    async filterRecipientsByPreferences(recipients, channel) {
        const filtered = [];
        for (const recipient of recipients) {
            // 检查用户订阅偏好
            if (recipient.type === 'user') {
                const subscriptions = await this.getSubscriptions(recipient.id);
                const subscription = subscriptions.find(s => s.channel === channel);
                if (subscription && !subscription.preferences.enabled) {
                    continue; // 跳过已禁用通知的用户
                }
                // 检查静默时间
                if (subscription?.preferences.quiet_hours) {
                    const now = new Date();
                    const quietHours = subscription.preferences.quiet_hours;
                    if (this.isInQuietHours(now, quietHours)) {
                        continue; // 跳过静默时间内的通知
                    }
                }
            }
            filtered.push(recipient);
        }
        return filtered;
    }
    isInQuietHours(now, quietHours) {
        // 简化的静默时间检查实现
        const currentTime = now.toTimeString().substring(0, 5); // HH:MM format
        if (quietHours.start <= quietHours.end) {
            return currentTime >= quietHours.start && currentTime <= quietHours.end;
        }
        else {
            // 跨天的情况
            return currentTime >= quietHours.start || currentTime <= quietHours.end;
        }
    }
    async scheduleNotification(notification, recipients) {
        const id = `scheduled_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        // 这里应该集成到调度服务中
        const delay = notification.scheduledAt.getTime() - Date.now();
        setTimeout(async () => {
            try {
                const channel = this.channels.get(notification.channel);
                if (channel) {
                    const result = await channel.sender(notification, recipients);
                    this.emit('notification:scheduled:sent', { notification, result });
                }
            }
            catch (error) {
                this.emit('notification:scheduled:error', { notification, error });
            }
        }, delay);
        const result = {
            id,
            status: 'pending',
            metadata: {
                scheduledAt: notification.scheduledAt,
                delay
            }
        };
        this.addToHistory({
            id,
            notification: { ...notification, recipients },
            result,
            createdAt: new Date()
        });
        return result;
    }
    renderTemplate(template, data) {
        // 简单的模板渲染实现
        return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
            return data[key] || match;
        });
    }
    addToHistory(history) {
        this.history.unshift(history);
        // 保持历史记录在合理范围内
        const maxHistorySize = 10000;
        if (this.history.length > maxHistorySize) {
            this.history = this.history.slice(0, maxHistorySize);
        }
    }
    /**
     * 获取服务统计信息
     */
    getStats() {
        return {
            channels: this.channels.size,
            templates: this.templates.size,
            historySize: this.history.length,
            subscriptions: Array.from(this.subscriptions.values()).reduce((total, subs) => total + subs.length, 0)
        };
    }
    /**
     * 清理历史记录
     */
    cleanHistory(beforeDate) {
        const originalSize = this.history.length;
        this.history = this.history.filter(h => h.createdAt >= beforeDate);
        const cleaned = originalSize - this.history.length;
        if (cleaned > 0) {
            this.logger.info(`Cleaned ${cleaned} notification history entries`);
        }
    }
}
exports.NotificationServiceImpl = NotificationServiceImpl;
// Re-export removed in Phase A to avoid duplicate export conflicts under isolatedModules
//# sourceMappingURL=NotificationService.js.map