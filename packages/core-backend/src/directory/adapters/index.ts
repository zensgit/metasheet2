import { registerDirectoryAdapter } from '../directory-adapter-registry'
import { dingtalkDirectoryAdapter } from './dingtalk-directory-adapter'
import { wecomDirectoryAdapter } from './wecom-directory-adapter'

registerDirectoryAdapter(dingtalkDirectoryAdapter)
registerDirectoryAdapter(wecomDirectoryAdapter)
