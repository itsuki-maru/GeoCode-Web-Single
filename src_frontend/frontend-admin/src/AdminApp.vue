<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { useRoute } from "vue-router";
import { useApplicationInitStore } from "./stores/appInits";

const route = useRoute();
const appInitStore = useApplicationInitStore();
const { appInitData } = storeToRefs(appInitStore);
const isLoginView = computed(() => route.name === "login");
</script>

<template>
  <div class="admin-app">
    <header class="app-header">
      <div class="header-inner">
        <div class="brand">
          <span class="brand-title" id="application-title">{{ appInitData.appTitle }}</span>
          <span class="admin-label">管理者画面</span>
        </div>
        <nav v-if="!isLoginView" class="admin-nav" aria-label="管理メニュー">
          <RouterLink to="/users/list">ユーザー管理</RouterLink>
          <RouterLink to="/live-maps">位置共有マップ</RouterLink>
        </nav>
      </div>
    </header>
    <main class="main-content" :class="{ 'login-content': isLoginView }">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.admin-app {
  min-height: 100vh;
}
.app-header {
  color: whitesmoke;
  background: var(--admin-header);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
}
.header-inner {
  width: min(1180px, calc(100% - 32px));
  min-height: 70px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.brand-title {
  overflow: hidden;
  font-size: clamp(1.3rem, 3vw, 1.8rem);
  font-weight: 700;
  letter-spacing: 0.03em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.admin-label {
  flex: 0 0 auto;
  padding: 3px 9px;
  border: 1px solid #777;
  border-radius: 999px;
  color: #e8e8e8;
  font-size: 0.75rem;
}
.admin-nav {
  display: flex;
  align-self: stretch;
  gap: 6px;
}
.admin-nav a {
  display: inline-flex;
  align-items: center;
  padding: 0 14px;
  border-bottom: 3px solid transparent;
  color: #d8d8d8;
  font-weight: 600;
}
.admin-nav a:hover {
  color: #fff;
  background: #282828;
  text-decoration: none;
}
.admin-nav a.router-link-active {
  border-bottom-color: #7ea2ef;
  color: #fff;
}
.main-content {
  min-height: calc(100vh - 70px);
}
.login-content {
  display: grid;
  place-items: center;
}

@media (max-width: 700px) {
  .header-inner {
    width: 100%;
    min-height: auto;
    align-items: stretch;
    flex-direction: column;
    gap: 0;
    padding-top: 14px;
  }
  .brand {
    width: min(100% - 24px, 1180px);
    margin: 0 auto 10px;
  }
  .admin-nav {
    width: 100%;
  }
  .admin-nav a {
    flex: 1;
    justify-content: center;
    min-height: 48px;
    padding: 0 8px;
    font-size: 0.9rem;
  }
  .main-content {
    min-height: calc(100vh - 118px);
  }
}
</style>
