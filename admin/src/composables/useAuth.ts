import { computed, ref } from 'vue';

const TOKEN_KEY = 'taxscan-admin-token';
const TOPIC_KEY = 'taxscan-admin-test-topic';

const token = ref<string | null>(localStorage.getItem(TOKEN_KEY));
const testSegmentTopic = ref<string>(localStorage.getItem(TOPIC_KEY) ?? 'test');

export function useAuth() {
  const isAuthed = computed(() => !!token.value);

  async function login(password: string): Promise<void> {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error === 'invalid_password' ? 'Invalid password' : 'Login failed');
    }
    const data = await res.json();
    token.value = data.token;
    if (data.testSegmentTopic) {
      testSegmentTopic.value = data.testSegmentTopic;
      localStorage.setItem(TOPIC_KEY, data.testSegmentTopic);
    }
    localStorage.setItem(TOKEN_KEY, data.token);
  }

  function logout(): void {
    token.value = null;
    localStorage.removeItem(TOKEN_KEY);
  }

  return { token, isAuthed, testSegmentTopic, login, logout };
}
