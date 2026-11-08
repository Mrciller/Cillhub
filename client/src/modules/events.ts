// MODULE_UI_EVENT {module_id, guild_id, data} (CONTRACT-v8 §6.4): store.ts hands it here, open panels of that module and
// server forward it to their iframe (bridge.tsx). Kept free of imports so the store can use it without a cycle.
export type UiEvent = { module_id: string; guild_id: string; data: unknown }
const listeners = new Set<(e: UiEvent) => void>()
export const moduleUiEvent = (e: UiEvent) => listeners.forEach((l) => l(e))
export const onModuleUiEvent = (l: (e: UiEvent) => void) => (listeners.add(l), () => void listeners.delete(l))
