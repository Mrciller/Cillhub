// Exact blame for broken node data: a region that renders one server's object (by its guild, channel or user id) sits in a
// NodeGuard with that id. A render error inside is that id's node's fault: the node is cut off (kept across starts) and the
// region shows nothing. A hub id (bare), or no id (a region that mixes several servers' data, like the emoji picker),
// passes the error on to main.tsx's Guard, past any NodeGuard around it: that one would blame the wrong node.
import { Component, type ReactNode } from 'react'
import { toast } from '../components/dialogs'
import { t } from '../i18n'
import { cutOff } from './nodes'
import { instanceById, nodeOf } from './registry'

const unowned = new WeakSet<object>()
const passOn = (e: unknown) => (e !== null && typeof e === 'object' && unowned.add(e), e)
const passed = (e: unknown) => e !== null && typeof e === 'object' && unowned.has(e)

export class NodeGuard extends Component<{ id: string | null | undefined; children: ReactNode }, { failed: boolean; error?: unknown }> {
  state: { failed: boolean; error?: unknown } = { failed: false }
  static getDerivedStateFromError = (error: unknown) => ({ failed: true, error })
  componentDidCatch(error: unknown) {
    const node = passed(error) ? undefined : nodeOf(this.props.id)
    const i = instanceById(node)
    if (!node || !i || i.status === 'cut-off') return // several regions of one node can fail in the same render
    cutOff(node)
    toast(t('Display error: {name} was disconnected so Cillhub stays usable. It stays off until you reconnect it.', { name: i.name }))
  }
  render() {
    if (!this.state.failed) return this.props.children
    if (!nodeOf(this.props.id) || passed(this.state.error)) throw passOn(this.state.error)
    return null
  }
}
