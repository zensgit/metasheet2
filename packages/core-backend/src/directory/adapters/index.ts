import { registerDirectoryAdapter } from '../directory-adapter-registry'
import { dingtalkDirectoryAdapter } from './dingtalk-directory-adapter'

registerDirectoryAdapter(dingtalkDirectoryAdapter)
