import { Component } from '@angular/core';
import { BoerdiChatComponent } from './boerdi-chat/boerdi-chat.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [BoerdiChatComponent],
  template: '<boerdi-chat></boerdi-chat>',
  styles: [':host { display: block; height: 100vh; }']
})
export class AppComponent {}
