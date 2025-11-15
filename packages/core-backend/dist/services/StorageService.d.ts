/**
 * 存储服务实现
 * 支持本地文件系统、AWS S3、阿里云OSS等多种存储后端
 */
import { Readable } from 'stream';
import { EventEmitter } from 'eventemitter3';
import type { StorageService, StorageFile, UploadOptions, GetUrlOptions, PresignedUploadOptions, PresignedUpload, ListOptions, StorageUsage } from '../types/plugin';
/**
 * 存储提供者接口
 */
interface StorageProvider {
    upload(file: Buffer | Readable, options: UploadOptions): Promise<StorageFile>;
    download(fileId: string): Promise<Buffer>;
    delete(fileId: string): Promise<void>;
    exists(fileId: string): Promise<boolean>;
    getFileInfo(fileId: string): Promise<StorageFile | null>;
    getFileUrl(fileId: string, options?: GetUrlOptions): Promise<string>;
    getPresignedUploadUrl(options: PresignedUploadOptions): Promise<PresignedUpload>;
    listFiles(prefix?: string, options?: ListOptions): Promise<StorageFile[]>;
    createFolder(path: string): Promise<void>;
    deleteFolder(path: string, recursive?: boolean): Promise<void>;
    getStorageUsage(): Promise<StorageUsage>;
}
/**
 * 本地文件系统存储提供者
 */
declare class LocalStorageProvider implements StorageProvider {
    private basePath;
    private baseUrl;
    private logger;
    private fileIndex;
    constructor(basePath: string, baseUrl?: string);
    private ensureBaseDir;
    private buildFileIndex;
    private scanDirectory;
    upload(file: Buffer | Readable, options: UploadOptions): Promise<StorageFile>;
    download(fileId: string): Promise<Buffer>;
    delete(fileId: string): Promise<void>;
    exists(fileId: string): Promise<boolean>;
    getFileInfo(fileId: string): Promise<StorageFile | null>;
    getFileUrl(fileId: string, options?: GetUrlOptions): Promise<string>;
    getPresignedUploadUrl(options: PresignedUploadOptions): Promise<PresignedUpload>;
    listFiles(prefix?: string, options?: ListOptions): Promise<StorageFile[]>;
    createFolder(dirPath: string): Promise<void>;
    deleteFolder(dirPath: string, recursive?: boolean): Promise<void>;
    getStorageUsage(): Promise<StorageUsage>;
    private generateFileId;
    private generateUniqueFileId;
    private generateFilename;
    private getContentType;
}
/**
 * AWS S3 存储提供者（示例实现）
 */
declare class S3StorageProvider implements StorageProvider {
    private s3Client;
    private bucket;
    private region;
    private logger;
    constructor(s3Client: any, bucket: string, region: string);
    upload(file: Buffer | Readable, options: UploadOptions): Promise<StorageFile>;
    download(fileId: string): Promise<Buffer>;
    delete(fileId: string): Promise<void>;
    exists(fileId: string): Promise<boolean>;
    getFileInfo(fileId: string): Promise<StorageFile | null>;
    getFileUrl(fileId: string, options?: GetUrlOptions): Promise<string>;
    getPresignedUploadUrl(options: PresignedUploadOptions): Promise<PresignedUpload>;
    listFiles(prefix?: string, options?: ListOptions): Promise<StorageFile[]>;
    createFolder(dirPath: string): Promise<void>;
    deleteFolder(dirPath: string, recursive?: boolean): Promise<void>;
    getStorageUsage(): Promise<StorageUsage>;
    private generateKey;
    private getContentType;
}
/**
 * 统一存储服务实现
 */
export declare class StorageServiceImpl extends EventEmitter implements StorageService {
    private provider;
    private logger;
    private uploadLimit;
    constructor(provider: StorageProvider, uploadLimit?: number);
    upload(file: Buffer | Readable, options: UploadOptions): Promise<StorageFile>;
    download(fileId: string): Promise<Buffer>;
    delete(fileId: string): Promise<void>;
    exists(fileId: string): Promise<boolean>;
    getFileInfo(fileId: string): Promise<StorageFile | null>;
    getFileUrl(fileId: string, options?: GetUrlOptions): Promise<string>;
    getPresignedUploadUrl(options: PresignedUploadOptions): Promise<PresignedUpload>;
    uploadMultiple(files: Array<{
        file: Buffer | Readable;
        options: UploadOptions;
    }>): Promise<StorageFile[]>;
    deleteMultiple(fileIds: string[]): Promise<void>;
    listFiles(prefix?: string, options?: ListOptions): Promise<StorageFile[]>;
    createFolder(path: string): Promise<void>;
    deleteFolder(path: string, recursive?: boolean): Promise<void>;
    getStorageUsage(): Promise<StorageUsage>;
    /**
     * 设置上传大小限制
     */
    setUploadLimit(limit: number): void;
    /**
     * 获取上传大小限制
     */
    getUploadLimit(): number;
    /**
     * 创建本地存储服务
     */
    static createLocalService(basePath: string, baseUrl?: string): StorageServiceImpl;
    /**
     * 创建 S3 存储服务
     */
    static createS3Service(s3Client: any, bucket: string, region: string): StorageServiceImpl;
}
export { LocalStorageProvider, S3StorageProvider };
//# sourceMappingURL=StorageService.d.ts.map