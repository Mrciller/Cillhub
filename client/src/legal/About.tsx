// User Settings → About: who runs this server, its legal pages, the source code (AGPL §13) and the licences.
import { useInstance } from '../admin/instance'
import { t } from '../i18n'
import { Link } from '../router'
import { setState } from '../store'

export function About() {
  const instance = useInstance()
  const legal = instance?.legal
  const go = () => setState({ modal: null }) // close the settings so the page shows
  return (
    <>
      <h1>{t('About')}</h1>
      <p>{legal?.operator_name ? t('{name} is run by {operator}.', { name: instance?.name ?? 'Cillhub', operator: legal.operator_name }) : t('The operator of this server has not entered their details yet.')}</p>
      {legal?.contact_email && <p>{t('Contact')}: <a href={`mailto:${legal.contact_email}`}>{legal.contact_email}</a></p>}
      <ul className="settings-links">
        <li><Link to="/imprint" onClick={go}>{t('Imprint')}</Link></li>
        <li><Link to="/privacy" onClick={go}>{t('Privacy notice')}</Link></li>
        <li><Link to="/terms" onClick={go}>{t('Terms of use')}</Link></li>
        <li><Link to="/report-content" onClick={go}>{t('Report illegal content')}</Link></li>
        <li><Link to="/licenses" onClick={go}>{t('Licences')}</Link></li>
        {legal?.source_url && <li><a href={legal.source_url} target="_blank" rel="noopener noreferrer">{t('Source code')}</a></li>}
      </ul>
      <p className="hint small">{t('Cillhub is free software under the GNU Affero General Public License, version 3.')}</p>
    </>
  )
}
