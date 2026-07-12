import { MetaSheetServer } from './src/index'
const s = new MetaSheetServer({ port: 0 })
const api = (s as unknown as { createCoreAPI: () => any }).createCoreAPI()
console.log('deleteRecord present:', typeof api?.multitable?.records?.deleteRecord)
