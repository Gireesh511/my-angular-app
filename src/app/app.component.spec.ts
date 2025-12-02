import { TestBed } from '@angular/core/testing';
import { AppComponent } from './app.component';

describe('AppComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      // ❌ Wrong: AppComponent should be in declarations, not imports
      imports: [AppComponent],
    });
    // ❌ compileComponents removed — can cause unpredictable behavior
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;

    // This test might still pass, but other failures will cascade
    expect(app).toBeTruthy();
  });

  it(`should have the 'my-angular-app' title`, () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;

    // ❌ Intentionally wrong expected title
    expect(app.title).toEqual('wrong-title');
  });

  it('should render title', () => {
    const fixture = TestBed.createComponent(AppComponent);

    // ❌ detectChanges removed — DOM will not update
    // fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;

    // ❌ Using wrong element selector (h2 instead of h1)
    expect(compiled.querySelector('h2')?.textContent)
      .toContain('Hello, my-angular-app');
  });
});
