import { spec } from 'node:test/reporters';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';

function section(file) {
  if (file.includes('/test/unit/')) return '유닛 테스트';
  if (file.includes('/test/domain/')) return '도메인 테스트';
  if (file.includes('/test/integration/')) return '통합 테스트';
  if (file.includes('/test/scenario/'))
    return 'E2E 테스트 (백엔드 사용자 시나리오)';
  if (file.includes('/test/transport/')) return '실제 전송 테스트';
  return '테스트';
}

async function* progress(events) {
  let heading;
  for await (const event of events) {
    if (event.type === 'test:dequeue' && event.data.file) {
      const { file, name, nesting } = event.data;
      const nextHeading = section(file.replaceAll('\\', '/'));
      let message = '';
      if (nextHeading !== heading) {
        heading = nextHeading;
        message += `\n${heading}\n\n`;
      }
      // The runner also enqueues file wrappers; only list actual test cases.
      if (resolve(name) !== resolve(file))
        message += `${'  '.repeat(nesting)}- [실행] ${name}\n`;
      if (message) yield { type: 'test:stdout', data: { file, message } };
    }
    yield event;
  }
}

// Keep Node's result, duration, skip and assertion-error formatting intact.
export default async function* reporter(source) {
  yield* Readable.from(progress(source)).compose(spec());
}
