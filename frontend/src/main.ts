import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
import './style.css';

// 主题初始化：尊重 localStorage 设置 / 默认浅色
(function initTheme() {
  const saved = localStorage.getItem('1shell-theme');
  const html = document.documentElement;
  if (saved === 'dark') html.classList.add('dark');
  else html.classList.remove('dark');
})();

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount('#app');
