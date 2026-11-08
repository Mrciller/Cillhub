// German UI dictionary (English source text -> German), split by area so it can be maintained per folder.
import { admin } from './de/admin'
import { chat } from './de/chat'
import { settings } from './de/settings'
import { shell } from './de/shell'
import { v4 } from './de/v4'
import { v5 } from './de/v5'
import { v6 } from './de/v6'
import { v7 } from './de/v7'
import { v8 } from './de/v8'

export const de: Record<string, string> = { ...admin, ...chat, ...settings, ...shell, ...v4, ...v5, ...v6, ...v7, ...v8 }
