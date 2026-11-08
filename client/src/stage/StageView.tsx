// Stage channels (type 13): topic banner, speakers, hands raised, audience, moderator controls (CONTRACT-v3 section 1).
import { t } from '../i18n'
import { useState } from 'react'
import { createStage, endStage, setMyStageState, setStageSpeaker, updateStage } from '../actions'
import { ask, askText, toastError } from '../components/dialogs'
import { MenuItem, Popover, useContextMenu } from '../components/menu'
import { Avatar, cls, Field, FormError, Icon, ICONS, Modal } from '../components/ui'
import { has, isStageModerator, P } from '../permissions'
import { memberName, usePerms } from '../selectors'
import { setState, useStore } from '../store'
import type { Channel, Guild, VoiceState } from '../types'
import { joinVoice, leaveVoice, setSelfMute } from '../voice/engine'
import { VoiceError } from '../voice/VoicePanel'
import { VoiceIcons } from '../voice/VoiceUsers'
import { useVoiceChat, VoiceChatPane } from '../voice/VoiceView'
import { headerAccent } from '../custom/channel'
import './stage.css'

const fail = toastError

function StageMember({ guild, channel, v, mod, big }: { guild: Guild; channel: Channel; v: VoiceState; mod: boolean; big?: boolean }) {
  const s = useStore((x) => x)
  const menu = useContextMenu()
  const name = memberName(s, guild.id, v.user_id)
  const speaking = !!s.voice.speaking[v.user_id] && s.voice.channelId === channel.id
  const hand = v.suppress && !!v.request_to_speak_timestamp
  const profile = (el: Element) => setState({ popout: { userId: v.user_id, guildId: guild.id, at: { rect: el.getBoundingClientRect(), side: 'right' } } })
  return (
    <li className={cls('stage-member', big && 'speaker', speaking && 'speaking')} {...menu.props}>
      <button className="stage-member-btn" aria-label={`${name}${hand ? t(', hand raised') : ''}${speaking ? t(', speaking') : ''}`} onClick={(e) => profile(e.currentTarget)}>
        <Avatar user={s.users[v.user_id] ?? v.member?.user} size={big ? 72 : 40} speaking={speaking} />
        {hand && <span className="stage-hand" role="img" aria-label={t('Hand raised')}><Icon d={ICONS.hand} size={14} /></span>}
        <span className="stage-name ellipsis">{name}</span>
        {big && <VoiceIcons v={v} />}
      </button>
      {menu.at && (
        <Popover at={menu.at} onClose={menu.close} role="menu" label={t('Actions for {name}', { name })}>
          <MenuItem onSelect={() => setState({ popout: { userId: v.user_id, guildId: guild.id, at: menu.at! } })}>{t('Profile')}</MenuItem>
          {mod && v.suppress && <MenuItem onSelect={() => setStageSpeaker(guild.id, channel.id, v.user_id, true).catch(fail)}>{t('Invite to Speak')}</MenuItem>}
          {mod && !v.suppress && <MenuItem onSelect={() => setStageSpeaker(guild.id, channel.id, v.user_id, false).catch(fail)}>{t('Move to Audience')}</MenuItem>}
        </Popover>
      )}
    </li>
  )
}

export function StageView({ channel, guild }: { channel: Channel; guild: Guild }) {
  const s = useStore((x) => x)
  const perms = usePerms(guild.id, channel.id)
  const mod = isStageModerator(perms)
  const chat = useVoiceChat()
  const instance = s.stageInstances[channel.id]
  const states = Object.values(s.voiceStates[guild.id] ?? {}).filter((v) => v.channel_id === channel.id)
  const here = s.voice.channelId === channel.id
  const mine = states.find((v) => v.user_id === s.me?.id)
  const byName = (a: VoiceState, b: VoiceState) => memberName(s, guild.id, a.user_id).localeCompare(memberName(s, guild.id, b.user_id))
  const speakers = states.filter((v) => !v.suppress).sort(byName)
  const requesting = states.filter((v) => v.suppress && v.request_to_speak_timestamp).sort((a, b) => a.request_to_speak_timestamp!.localeCompare(b.request_to_speak_timestamp!))
  const audience = states.filter((v) => v.suppress && (!mod || !v.request_to_speak_timestamp)).sort(byName)
  const handUp = !!mine?.request_to_speak_timestamp

  const editTopic = () =>
    void askText({ title: t('Edit Stage Topic'), label: t('Topic'), initial: instance?.topic ?? '', maxLength: 120 }).then((v) => void (v && updateStage(channel.id, v.trim()).catch(fail)))
  const end = () =>
    void ask({ title: t('End Stage'), body: <p>{t('Everyone will be moved to the audience and the topic will be cleared.')}</p>, confirm: t('End Stage'), danger: true })
      .then((ok) => void (ok && endStage(channel.id).catch(fail)))
  const self = (body: Parameters<typeof setMyStageState>[2]) => setMyStageState(guild.id, channel.id, body).catch(fail)

  return (
    <main className="chat voice-view stage-view" aria-label={t('Stage channel {name}', { name: channel.name ?? '' })}>
      <header className="chat-header" {...headerAccent(channel)}>
        <button className="icon-btn back" aria-label={t('Back to channels')} onClick={() => setState({ showNav: true })}>
          <Icon d={ICONS.back} />
        </button>
        <Icon d={ICONS.stage} size={24} className="chan-icon" />
        <h1 className="ellipsis">{channel.name}</h1>
        <span className="spacer" />
        {chat.button}
      </header>
      <div className="voice-split">
        <div className="voice-col">
          <div className="voice-body stage-body">
            {here && <VoiceError />}
            <section className="stage-banner" aria-label={t('Stage topic')}>
              {instance ? (
                <>
                  <span className="live">{t('LIVE')}</span>
                  <h2 className="stage-topic">{instance.topic}</h2>
                  <p className="hint">{speakers.length} speaking · {states.length - speakers.length} listening</p>
                  {mod && (
                    <div className="row-buttons">
                      <button className="secondary small-btn" onClick={editTopic}>{t('Edit Topic')}</button>
                      <button className="danger-btn small-btn" onClick={end}>{t('End Stage')}</button>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <h2 className="stage-topic">{channel.name}</h2>
                  <p className="hint">{mod ? t('Start the stage to set a topic and let people know you are live.') : t("This stage hasn't started yet.")}</p>
                  {mod && <button className="primary" onClick={() => setState({ modal: { kind: 'start-stage', channelId: channel.id } })}>{t('Start Stage')}</button>}
                </>
              )}
            </section>
            <h3 className="list-heading">{t('Speakers — {n}', { n: speakers.length })}</h3>
            <ul className="stage-speakers" aria-label={t('Speakers')}>
              {speakers.map((v) => <StageMember key={v.user_id} guild={guild} channel={channel} v={v} mod={mod} big />)}
            </ul>
            {mod && requesting.length > 0 && (
              <>
                <h3 className="list-heading">{t('Requested to Speak — {n}', { n: requesting.length })}</h3>
                <ul className="stage-requests" aria-label={t('Requested to Speak')}>
                  {requesting.map((v) => (
                    <li key={v.user_id} className="stage-request">
                      <Avatar user={s.users[v.user_id] ?? v.member?.user} size={32} />
                      <span className="ellipsis">{memberName(s, guild.id, v.user_id)}</span>
                      <span className="spacer" />
                      <button className="primary small-btn" aria-label={t('Invite {name} to Speak', { name: memberName(s, guild.id, v.user_id) })} onClick={() => setStageSpeaker(guild.id, channel.id, v.user_id, true).catch(fail)}>
                        Invite to Speak
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <h3 className="list-heading">{t('Audience — {n}', { n: audience.length })}</h3>
            <ul className="stage-audience" aria-label={t('Audience')}>
              {audience.map((v) => <StageMember key={v.user_id} guild={guild} channel={channel} v={v} mod={mod} />)}
            </ul>
            {!here && (
              <div className="voice-join">
                {!has(perms, P.CONNECT) ? <p className="hint">{t('You do not have permission to join this stage.')}</p>
                  : <button className="primary" onClick={() => joinVoice(guild.id, channel.id)}>{t('Join Stage')}</button>}
              </div>
            )}
          </div>
          {here && (
            <div className="call-bar" role="group" aria-label={t('Stage controls')}>
              {mine?.suppress ? (
                <>
                  {has(perms, P.REQUEST_TO_SPEAK) && !mod && (
                    <button className={cls('vp-btn big', handUp && 'on')} aria-pressed={handUp} aria-label={handUp ? t('Lower Hand') : t('Raise Hand')} title={handUp ? t('Lower Hand') : t('Raise Hand')}
                      onClick={() => self({ request_to_speak_timestamp: handUp ? null : new Date().toISOString() })}>
                      <Icon d={ICONS.hand} />
                    </button>
                  )}
                  {mod && <button className="primary" onClick={() => self({ suppress: false })}>{t('Become a Speaker')}</button>}
                </>
              ) : mine ? (
                <>
                  <button className={cls('vp-btn big', s.voice.selfMute && 'danger-on')} aria-pressed={s.voice.selfMute} aria-label={t('Mute')} onClick={() => setSelfMute(!s.voice.selfMute)}>
                    <Icon d={s.voice.selfMute ? ICONS.micOff : ICONS.mic} />
                  </button>
                  <button className="secondary" onClick={() => self({ suppress: true })}>{t('Move to Audience')}</button>
                </>
              ) : null}
              <button className="vp-btn big hangup" aria-label={t('Disconnect')} onClick={leaveVoice}>
                <Icon d={ICONS.hangup} />
              </button>
            </div>
          )}
        </div>
        {chat.open && <VoiceChatPane channel={channel} guild={guild} onClose={chat.close} />}
      </div>
    </main>
  )
}

/** Modal kind 'start-stage': topic, then the stage goes live and its starter becomes a speaker if already on stage. */
export function StartStageModal({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const channel = useStore((s) => s.channels[channelId])
  const here = useStore((s) => s.voice.channelId === channelId)
  const [topic, setTopic] = useState('')
  const [error, setError] = useState('')
  if (!channel?.guild_id) return null
  const guildId = channel.guild_id
  const start = () =>
    createStage(channelId, topic.trim()).then(async () => {
      if (here) await setMyStageState(guildId, channelId, { suppress: false }).catch(() => {})
      else joinVoice(guildId, channelId)
      onClose()
    }, (e: Error) => setError(e.message))
  return (
    <Modal title={t('Start Stage')} onClose={onClose}>
      <form onSubmit={(e) => (e.preventDefault(), topic.trim() && start())}>
        <p className="hint">{t('Set a topic so everyone knows what this stage is about.')}</p>
        <Field label={t('Topic')} required maxLength={120} placeholder={t('Season kickoff Q&A')} value={topic} onChange={(e) => setTopic(e.target.value)} autoFocus />
        <FormError error={error} />
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button>
          <button className="primary" disabled={!topic.trim()}>{t('Start Stage')}</button>
        </div>
      </form>
    </Modal>
  )
}
