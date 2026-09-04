<template>
  <section class="page-shell not-found">
    <p class="error-code">404</p>
    <h1>ページが見つかりません</h1>
    <p>指定された管理画面は存在しないか、移動した可能性があります。</p>
    <RouterLink class="button button-primary" to="/users/list">ユーザー管理へ戻る</RouterLink>
  </section>
</template>

<style scoped>
.not-found {
  padding-top: 12vh;
  text-align: center;
}
.error-code {
  margin-bottom: 0;
  color: var(--admin-primary);
  font-size: clamp(4rem, 14vw, 8rem);
  font-weight: 800;
  line-height: 1;
}
.not-found > p:not(.error-code) {
  color: var(--admin-text-muted);
}
</style>
