import { tokenOf, useInstances } from '../instances/registry'
import { useEffect } from 'react'
import { loadMembers, loadSettings, openMessage } from '../actions'
import { IncomingCall } from '../calls/IncomingCall'
import { InteractionModalView } from '../components-ui/InteractionModal'
import { GroupDmModal, GroupMembers } from '../friends/GroupDm'
import { QuickSwitcher } from '../keyboard/QuickSwitcher'
import { ShortcutSheet } from '../keyboard/ShortcutSheet'
import { useShortcuts } from '../keyboard/shortcuts'
import { NotificationSettingsModal } from '../notifications/NotificationSettings'
import { CustomStatusModal } from '../profiles/CustomStatusModal'
import { ProfileModal } from '../profiles/ProfileModal'
import { t } from '../i18n'
import { FolderModal } from './GuildRail'
import { Chat } from '../chat/Chat'
import { FollowModal, ForwardModal } from '../chat/ForwardModal'
import { EventsModal } from '../events/Events'
import { ForumView } from '../forum/ForumView'
import { TimeoutModal } from '../moderation/TimeoutModal'
import { RulesModal, WelcomeModal } from '../moderation/Onboarding'
import { SearchPanel } from '../search/SearchPanel'
import { StageView, StartStageModal } from '../stage/StageView'
import { CreateThreadModal } from '../threads/CreateThreadModal'
import { ThreadPanel } from '../threads/ThreadPanel'
import { CanvasPanel } from '../canvas/CanvasPanel'
import { DialogHost } from './dialogs'
import { Friends } from '../friends/Friends'
import { connect, disconnect } from '../gateway'
import { has, P } from '../permissions'
import { navigate } from '../router'
import { firstText, myMember, permsOf } from '../selectors'
import { ChannelSettings } from '../settings/ChannelSettings'
import { BanModal } from '../settings/Members'
import { ServerSettings } from '../settings/ServerSettings'
import { UserSettings } from '../settings/UserSettings'
import { useWhatsNewOnce, WhatsNewModal } from '../whatsnew/WhatsNew'
import { setState, useStore } from '../store'
import { VoiceView } from '../voice/VoiceView'
import { DmSidebar } from './DmSidebar'
import { CreateChannelModal, GuildSidebar } from './GuildSidebar'
import { GuildRail } from './GuildRail'
import { MemberList } from './MemberList'
import { UserPanel } from './UserPanel'
import { UserPopout } from './UserPopout'
import { NodeStatus } from '../instances/InstanceUI'
import { ModuleMainPage, ModuleSidePanel } from '../modules/ModulePanel'
import { ServerGuide } from '../guilds/ServerGuide'
import { RoleSimulatorBanner } from '../guilds/RoleSimulator'
import { InviteUserModal } from './InviteUserModal'
import { ResizeHandle } from './ResizeHandle'
import './shell-v4.css'

function Modals() {
  const modal = useStore((s) => s.modal)
  const close = () => setState({ modal: null })
  switch (modal?.kind) {
    case 'server': return <ServerSettings guildId={modal.guildId} tab={modal.tab} onClose={close} />
    case 'channel': return <ChannelSettings channelId={modal.channelId} onClose={close} />
    case 'user': return <UserSettings tab={modal.tab} onClose={close} />
    case 'ban': return <BanModal guildId={modal.guildId} userId={modal.userId} onClose={close} />
    case 'create-channel': return <CreateChannelModal guildId={modal.guildId} parentId={modal.parentId} type={modal.type} onClose={close} />
    case 'timeout': return <TimeoutModal guildId={modal.guildId} userId={modal.userId} onClose={close} />
    case 'create-thread': return <CreateThreadModal channelId={modal.channelId} messageId={modal.messageId} onClose={close} />
    case 'forward': return <ForwardModal channelId={modal.channelId} messageId={modal.messageId} onClose={close} />
    case 'follow': return <FollowModal channelId={modal.channelId} onClose={close} />
    case 'events': return <EventsModal guildId={modal.guildId} eventId={modal.eventId} edit={modal.edit} create={modal.create} onClose={close} />
    case 'welcome': return <WelcomeModal guildId={modal.guildId} onClose={close} />
    case 'rules': return <RulesModal guildId={modal.guildId} onClose={close} />
    case 'start-stage': return <StartStageModal channelId={modal.channelId} onClose={close} />
    case 'profile': return <ProfileModal key={modal.userId} userId={modal.userId} guildId={modal.guildId} tab={modal.tab} onClose={close} />
    case 'group-dm': return <GroupDmModal channelId={modal.channelId} onClose={close} />
    case 'notifications': return <NotificationSettingsModal guildId={modal.guildId} onClose={close} />
    case 'custom-status': return <CustomStatusModal onClose={close} />
    case 'quick-switcher': return <QuickSwitcher onClose={close} />
    case 'shortcuts': return <ShortcutSheet onClose={close} />
    case 'folder': return <FolderModal folderId={modal.folderId} onClose={close} />
    case 'interaction-modal': return <InteractionModalView key={modal.data.id} data={modal.data} onClose={close} />
    case 'whats-new': return <WhatsNewModal onClose={close} />
    case 'invite-user': return <InviteUserModal userId={modal.userId} onClose={close} />
    default: return null
  }
}

// Own member (roles) per guild, needed for permissions, when READY did not include it.
const requested = new Set<string>()
function useOwnMembers() {
  const s = useStore((x) => x)
  useEffect(() => {
    if (s.status !== 'ready') return
    for (const id of Object.keys(s.guilds))
      if (!myMember(s, id) && !s.membersLoaded[id] && !requested.has(id)) {
        requested.add(id)
        loadMembers(id).catch(() => requested.delete(id))
      }
  })
}

export function Shell({ guildId, channelId, messageId }: { guildId: string; channelId?: string; messageId?: string }) {
  useEffect(() => {
    connect()
    return disconnect
  }, [])
  useOwnMembers()
  useShortcuts(guildId, channelId)
  const s = useStore((x) => x)
  // Settings may hold more than READY's user_settings carried (older servers send only the status).
  useEffect(() => void (s.status === 'ready' && loadSettings().catch(() => {})), [s.status])
  useWhatsNewOnce(s.status === 'ready')
  const { status, showNav } = s
  useEffect(() => {
    if (status !== 'ready' || !channelId || !messageId) return
    navigate(`/channels/${guildId}/${channelId}`, true)
    void openMessage(channelId, messageId, guildId === '@me' ? undefined : guildId)
  }, [status, guildId, channelId, messageId])
  const guild = guildId === '@me' ? undefined : s.guilds[guildId]
  const channel = channelId ? s.channels[channelId] : undefined

  const home = guildId === '@me'
  // Until our own member is known, permissions may be too low to judge whether a channel is visible.
  const known = !guild || guild.owner_id === s.me?.id || !!myMember(s, guild.id) || !!s.membersLoaded[guild.id]
  const viewable = !!channel && (home ? channel.type === 1 || channel.type === 3 : channel.guild_id === guildId && channel.type !== 4 && (!known || has(permsOf(s, guild?.id, channel), P.VIEW_CHANNEL)))
  // The side panel (thread or search) only belongs to the guild/DM on screen.
  const panelChannel = s.panel?.kind === 'thread' ? s.channels[s.panel.channelId] : undefined
  const panel = s.panel?.kind === 'thread' ? (panelChannel?.guild_id === guild?.id && guild ? s.panel : null)
    : s.panel?.kind === 'search' ? (s.panel.guildId ? s.panel.guildId === guild?.id : !!s.panel.channelId && s.panel.channelId === channelId) ? s.panel : null
    : s.panel?.kind === 'module' ? (s.panel.guildId === guild?.id ? s.panel : null)
    : s.panel?.kind === 'canvas' ? (s.panel.channelId === channelId ? s.panel : null)
    : null
  const page = guild && s.modulePage?.guildId === guild.id ? s.modulePage : null // v8: a module page in place of the chat
  const guide = guild && s.guideGuildId === guild.id // v13: server guide in place of the chat
  const visible = viewable ? channel : undefined
  const first = guild && known ? firstText(s, guild.id) : undefined
  // Only after READY do we know that a guild or channel in the URL is really gone; a node server only once its node answered.
  const nodesPending = Object.values(useInstances()).some((i) => i.status === 'connecting' && !!tokenOf(i.id))
  const target =
    status !== 'ready' || visible ? null
    : home ? (channelId ? '/channels/@me' : null)
    : !guild ? (nodesPending ? null : '/channels/@me')
    : first ? `/channels/${guild.id}/${first.id}` : null
  useEffect(() => void (target && navigate(target, true)), [target])

  const friends = home && !channelId
  const voiceLike = visible?.type === 2 || visible?.type === 13
  return (
    <div className="app" data-pane={(visible || friends || page || guide) && !showNav ? 'chat' : 'nav'} data-gateway={status} data-panel={panel ? panel.kind : undefined}>
      <div className="conn" role="status">{status === 'ready' ? <NodeStatus guildId={guild?.id} /> : t('Connecting…')}</div>
      <GuildRail guildId={guildId} />
      <div className="sidebar">
        {guild ? <GuildSidebar guild={guild} channelId={page || guide ? undefined : visible?.id} /> : <DmSidebar channelId={visible?.id} />}
        <UserPanel />
        <ResizeHandle
          id="sidebar-resizer"
          side="right"
          defaultValue={216}
          min={160}
          max={480}
          storageKey="cillhub:sidebar-width"
          cssVar="--sidebar-width"
          ariaLabel={t('Resize channel sidebar')}
        />
      </div>
      <div className="server-main-col">
        {guild && <RoleSimulatorBanner guild={guild} />}
        {page ? (
          <ModuleMainPage key={page.moduleId + page.panelId} {...page} channelId={visible?.id ?? null} />
        ) : guide ? (
          <ServerGuide key={guild.id} guild={guild} onClose={() => setState({ guideGuildId: null })} />
        ) : visible?.type === 2 && guild ? (
          <VoiceView key={visible.id} channel={visible} guild={guild} />
        ) : visible?.type === 13 && guild ? (
          <StageView key={visible.id} channel={visible} guild={guild} />
        ) : visible?.type === 15 && guild ? (
          <ForumView key={visible.id} channel={visible} guild={guild} />
        ) : visible ? (
          <Chat key={visible.id} channel={visible} guild={guild} />
        ) : friends ? (
          <Friends />
        ) : (
          <main className="chat empty">
            <p>{home ? t('Pick a conversation on the left, or find someone to talk to.') : t('No channel selected.')}</p>
          </main>
        )}
      </div>
      {panel?.kind === 'thread' ? <ThreadPanel key={panel.channelId} channelId={panel.channelId} />
        : panel?.kind === 'canvas' ? <CanvasPanel key={panel.channelId} channelId={panel.channelId} />
        : panel?.kind === 'module' ? <ModuleSidePanel key={panel.moduleId + panel.panelId} guildId={panel.guildId} moduleId={panel.moduleId} panelId={panel.panelId} channelId={visible?.id ?? null} />
        : panel?.kind === 'search' ? <SearchPanel key={panel.query + (panel.guildId ?? panel.channelId)} guildId={panel.guildId} channelId={panel.channelId} query={panel.query} />
        : guild && !voiceLike && visible?.type !== 15 ? s.showMembers && <MemberList guild={guild} />
        : visible?.type === 3 && s.showMembers && <GroupMembers channel={visible} />}
      <Modals />
      <IncomingCall />
      <UserPopout />
      <DialogHost />
    </div>
  )
}
