// captcha.html: renders this instance's reCAPTCHA checkbox and hands the token to the Android app (CillhubCaptcha bridge)
const say = text => { document.getElementById('msg').textContent = text; };
window.cillhubCaptchaLoaded = async () => {
  const info = await fetch('/api/v9/instance').then(r => r.json()).catch(() => null);
  if (!info?.captcha) return say('This server does not use a captcha.');
  window.grecaptcha.render('box', { sitekey: info.captcha.sitekey, theme: 'dark', callback: token => window.CillhubCaptcha?.postMessage(token) });
};
const s = document.createElement('script');
s.src = 'https://www.google.com/recaptcha/api.js?onload=cillhubCaptchaLoaded&render=explicit';
s.onerror = () => say('The captcha could not be loaded. Check your connection.');
document.head.append(s);
