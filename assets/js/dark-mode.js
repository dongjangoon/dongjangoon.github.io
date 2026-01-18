// Dark Mode Toggle
(function() {
  // Get saved theme or default to light
  const savedTheme = localStorage.getItem('theme') || 'light';

  // Apply saved theme immediately (before page renders)
  if (savedTheme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  }

  // Wait for DOM to be ready
  document.addEventListener('DOMContentLoaded', function() {
    // Create toggle button
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'dark-mode-toggle';
    toggleBtn.setAttribute('aria-label', 'Toggle dark mode');
    toggleBtn.innerHTML = `
      <i class="fas fa-moon moon-icon"></i>
      <i class="fas fa-sun sun-icon"></i>
    `;

    // Insert toggle button into navigation
    const nav = document.querySelector('.greedy-nav .visible-links');
    if (nav) {
      const li = document.createElement('li');
      li.className = 'masthead__menu-item';
      li.appendChild(toggleBtn);
      nav.appendChild(li);
    }

    // Toggle function
    toggleBtn.addEventListener('click', function() {
      const currentTheme = document.documentElement.getAttribute('data-theme');
      const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

      document.documentElement.setAttribute('data-theme', newTheme);
      localStorage.setItem('theme', newTheme);
    });

    // Also check for system preference
    if (!localStorage.getItem('theme')) {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (prefersDark) {
        document.documentElement.setAttribute('data-theme', 'dark');
      }
    }
  });
})();
