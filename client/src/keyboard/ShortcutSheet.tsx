import { Modal } from '../components/ui'
import { t } from '../i18n'
import { shortcutList } from './shortcuts'

const mac = /Mac|iPhone|iPad/.test(navigator.platform)
export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  return (
    <Modal title={t('Keyboard Shortcuts')} onClose={onClose} className="shortcut-sheet">
      <dl className="shortcuts">
        {shortcutList().map(([keys, what]) => (
          <div key={keys} className="shortcut-row">
            <dt>{t(what)}</dt>
            <dd>{keys.split(' / ').map((k) => <kbd key={k} className="keybind">{mac ? k.replace(/Ctrl/g, '⌘') : k}</kbd>)}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}
