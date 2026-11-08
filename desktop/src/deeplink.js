// cillcord://invite/<code> or cillhub://invite/<code> -> "/invite/<code>"; anything else -> null.
const PROTOCOLS = ['cillcord', 'cillhub'];
function deepLinkPath(arg) {
  const m = /^(?:cillcord|cillhub):\/\/invite\/([A-Za-z0-9-]{2,32})\/?$/i.exec(String(arg || ''));
  return m ? `/invite/${m[1]}` : null;
}
const findDeepLink = (argv) => argv.find((a) => PROTOCOLS.some((p) => String(a).toLowerCase().startsWith(`${p}://`)));
module.exports = { PROTOCOLS, deepLinkPath, findDeepLink };
