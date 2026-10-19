let registration;
let pendingInstall;
let lastPage;
let savedPage;
let updateRequested = false;
let reading = () => false;
const el = id => document.getElementById(id);
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault(); pendingInstall = event;
  if (el('installApp')) el('installApp').textContent = 'Құран қолданбасын орнату';
});

function status(text) { el('pwaStatus').textContent = text; }
function connectionStatus() {
  if (!navigator.onLine) { status('Офлайн · сақталған беттерді оқуға болады. Дауыс қызметіне интернет қажет болуы мүмкін.'); return; }
  status(savedPage === lastPage ? `${lastPage}-бет интернетсіз оқуға сақталды` : 'Қаралған беттер интернетсіз оқу үшін сақталады');
}

export function rememberOfflinePage(page) {
  lastPage = page;
  const worker = navigator.serviceWorker?.controller || registration?.active;
  worker?.postMessage({ type: 'SAVE_READING_PAGE', page });
}

export async function initPwa({ isReading }) {
  reading = isReading;
  el('pwaTools').classList.remove('hidden');
  const install = el('installApp');
  const refreshInstall = () => {
    install.classList.toggle('hidden', standalone());
    install.textContent = pendingInstall ? 'Құран қолданбасын орнату' : 'Телефонға орнату';
  };
  window.addEventListener('appinstalled', () => { pendingInstall = null; refreshInstall(); install.classList.add('hidden'); status('Құран қолданбасы орнатылды'); });
  install.addEventListener('click', async () => {
    if (pendingInstall) {
      const prompt = pendingInstall; pendingInstall = null;
      await prompt.prompt(); await prompt.userChoice; refreshInstall();
    } else {
      el('pwaInstallHelp').classList.remove('hidden');
      el('pwaInstallHelp').textContent = /iPhone|iPad|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
        ? 'Safari: «Бөлісу» → «Басты экранға қосу» → «Қосу».'
        : 'Браузер мәзірінен «Қолданбаны орнату» немесе «Басты экранға қосу» таңдаңыз.';
    }
  });
  el('updateApp').addEventListener('click', () => {
    if (reading()) { status('Жаңарту үшін оқуды аяқтаңыз. Оқу орны сақталады.'); return; }
    if (!registration?.waiting) return;
    updateRequested = true;
    registration.waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
  });
  window.addEventListener('online', connectionStatus);
  window.addEventListener('offline', connectionStatus);
  refreshInstall(); connectionStatus();
  if (!('serviceWorker' in navigator)) { status('Бұл браузер офлайн сақтауды қолдамайды'); return; }
  navigator.serviceWorker.addEventListener('message', ({ data }) => {
    if (data?.page !== lastPage) return;
    if (data.type === 'READING_PAGE_SAVED') { savedPage = data.page; connectionStatus(); }
    if (data.type === 'READING_PAGE_SAVE_FAILED') status('Бұл бет толық сақталмады. Интернетпен қайта ашыңыз.');
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updateRequested) { location.reload(); return; }
    if (lastPage) rememberOfflinePage(lastPage);
  });
  try {
    registration = await navigator.serviceWorker.register(new URL('./sw.js', import.meta.url), { updateViaCache: 'none' });
    const showUpdate = () => { if (registration.waiting) el('updateApp').classList.remove('hidden'); };
    showUpdate();
    registration.addEventListener('updatefound', () => {
      registration.installing?.addEventListener('statechange', showUpdate);
    });
    await navigator.serviceWorker.ready;
    if (lastPage) rememberOfflinePage(lastPage);
  } catch { status('Офлайн сақтау қосылмады. Интернетпен қайта ашып көріңіз.'); }
}
