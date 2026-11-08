(() => {
  const root = document.documentElement;
  const media = matchMedia('(prefers-color-scheme: dark)');
  const themes = ['light', 'dark', 'system'];
  let theme = 'system';
  try {
    const saved = localStorage.getItem('cqa.theme');
    if (themes.includes(saved)) theme = saved;
  } catch {}
  const applyTheme = () => {
    root.dataset.theme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
    for (const control of document.querySelectorAll('[data-theme-choice]')) {
      control.setAttribute('aria-pressed', String(control.dataset.themeChoice === theme));
    }
  };
  applyTheme();
  media.addEventListener('change', () => {
    if (theme === 'system') applyTheme();
  });

  document.addEventListener('DOMContentLoaded', () => {
    applyTheme();
    requestAnimationFrame(() => requestAnimationFrame(() => { root.dataset.ready = ''; }));
    document.querySelector('.theme-control').addEventListener('click', (event) => {
      const control = event.target.closest('[data-theme-choice]');
      if (!control || theme === control.dataset.themeChoice) return;
      theme = control.dataset.themeChoice;
      try { localStorage.setItem('cqa.theme', theme); } catch {}
      if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        document.startViewTransition(applyTheme);
      } else {
        applyTheme();
      }
    });

    const trigger = document.getElementById('language-trigger');
    const options = document.getElementById('language-options');
    const closeLanguage = (focus = false) => {
      trigger.setAttribute('aria-expanded', 'false');
      options.hidden = true;
      if (focus) trigger.focus();
    };
    trigger.addEventListener('click', () => {
      if (!options.hidden) {
        closeLanguage();
        return;
      }
      trigger.setAttribute('aria-expanded', 'true');
      options.hidden = false;
      options.querySelector('[aria-pressed="true"]')?.focus();
    });
    document.addEventListener('click', (event) => {
      if (!trigger.parentElement.contains(event.target)) closeLanguage();
    });
    trigger.parentElement.addEventListener('focusout', (event) => {
      if (!trigger.parentElement.contains(event.relatedTarget)) closeLanguage();
    });
    trigger.parentElement.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || options.hidden) return;
      event.preventDefault();
      closeLanguage(true);
    });
    for (const [name, close] of [['language', () => closeLanguage(true)], ['channel', () => {}]]) {
      const select = document.getElementById(name);
      const buttons = document.querySelectorAll('[data-' + name + ']');
      for (const control of buttons) {
        control.addEventListener('click', () => {
          select.value = control.dataset[name];
          select.dispatchEvent(new Event('change'));
          close();
        });
      }
    }
    const navigation = document.querySelectorAll('.navigation a');
    const syncNavigation = () => {
      const target = location.hash === '#workspace' ? '#workspace' : '#overview';
      const breadcrumb = document.querySelector('.breadcrumb');
      breadcrumb.textContent = 'Контроль качества / ' + (target === '#workspace' ? 'Рабочая область' : 'Обзор');
      const workspace = document.getElementById('workspace');
      workspace.hidden = target !== '#workspace';
      for (const view of document.querySelectorAll('.home-view')) view.hidden = target === '#workspace';
      for (const link of navigation) {
        if (link.hash === target) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      }
    };
    syncNavigation();
    window.addEventListener('hashchange', syncNavigation);
    document.getElementById('nav-editor').addEventListener('click', () => document.getElementById('open-editor').click());
  });
})();
