import { Controller, Get } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

@Controller()
export class AppController {
  constructor(private readonly http: HttpService) {}

  /**
   * Calls an external API through Nest's HttpService (axios under the hood).
   * netbridge captures this via the http/https wrapper.
   */
  @Get('axios-demo')
  async axiosDemo() {
    const res = await firstValueFrom(
      this.http.get('https://jsonplaceholder.typicode.com/users/1')
    );
    return { via: 'nest HttpService (axios)', user: res.data.name };
  }

  /**
   * Calls an external API through native fetch.
   * netbridge captures this via the fetch wrapper.
   */
  @Get('fetch-demo')
  async fetchDemo() {
    const res = await fetch('https://jsonplaceholder.typicode.com/todos/1');
    const todo = await res.json();
    return { via: 'native fetch', todo: todo.title };
  }

  /**
   * One endpoint that fans out to several upstream calls —
   * the realistic backend-for-frontend pattern.
   */
  @Get('aggregate')
  async aggregate() {
    const [user, posts] = await Promise.all([
      firstValueFrom(this.http.get('https://jsonplaceholder.typicode.com/users/2')),
      fetch('https://jsonplaceholder.typicode.com/posts?userId=2').then((r) => r.json()),
    ]);
    return { user: user.data.name, postCount: posts.length };
  }
}
