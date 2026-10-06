// Theme switch: light or dark. Without a stored choice the page follows the
// system setting (and keeps following it); a click stores the choice in this
// browser. The <head> sets data-theme before the first paint, so the page does
// not flash in the wrong theme.
(function () {
  var root = document.documentElement;
  var light = window.matchMedia('(prefers-color-scheme: light)');
  // The choice made on this page, for when storage is blocked.
  var chosen = null;
  var COLORS = { dark: '#141414', light: '#F5F2EC' };

  function stored() {
    if (chosen) return chosen;
    try {
      var t = localStorage.getItem('theme');
      return t === 'light' || t === 'dark' ? t : null;
    } catch (e) {
      return null;
    }
  }

  function apply(theme) {
    root.dataset.theme = theme;
    // The browser bar follows the page theme, not only the system setting.
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (meta) {
      meta.setAttribute('content', COLORS[theme]);
    });
    var button = document.querySelector('.theme-toggle');
    if (button) {
      // The label says what a click does.
      button.setAttribute('aria-label', theme === 'dark' ? button.dataset.labelLight : button.dataset.labelDark);
      button.setAttribute('title', button.getAttribute('aria-label'));
    }
  }

  apply(stored() || (light.matches ? 'light' : 'dark'));
  root.dataset.themeReady = '';
  light.addEventListener('change', function (e) {
    if (!stored()) apply(e.matches ? 'light' : 'dark');
  });

  document.addEventListener('click', function (e) {
    var button = e.target.closest && e.target.closest('.theme-toggle');
    if (!button) return;
    var next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    chosen = next;
    try {
      localStorage.setItem('theme', next);
    } catch (err) {
      // Private mode or blocked storage: the choice lasts for this page.
    }
    apply(next);
  });
})();
