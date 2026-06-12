import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import axios from 'axios';

/**
 * Server function: always runs on the server, never in the browser.
 * Makes calls through BOTH HTTP stacks so netbridge captures both:
 * - native fetch  → undici stack
 * - axios         → http/https stack
 */
const getDashboardData = createServerFn({ method: 'GET' }).handler(async () => {
  const [todoRes, user] = await Promise.all([
    fetch('https://jsonplaceholder.typicode.com/todos/1').then((r) => r.json()),
    axios.get('https://jsonplaceholder.typicode.com/users/1').then((r) => r.data),
  ]);
  return {
    todo: todoRes.title as string,
    user: user.name as string,
  };
});

export const Route = createFileRoute('/')({
  loader: () => getDashboardData(),
  component: Home,
});

function Home() {
  const data = Route.useLoaderData();
  return (
    <main style={{ fontFamily: 'monospace', padding: 32 }}>
      <h1>netbridge × TanStack Start</h1>
      <p>
        These values were fetched <strong>server-side</strong> during SSR — the upstream requests
        are invisible to browser DevTools, but visible in the netbridge UI:
      </p>
      <ul>
        <li>via native fetch: {data.todo}</li>
        <li>via axios: {data.user}</li>
      </ul>
    </main>
  );
}
