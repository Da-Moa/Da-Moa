import { ValidateBy } from 'class-validator';

// Preserve the API's trimmed UTF-16 length without changing the raw DTO values
// that participate in idempotency digests. IsString owns non-string failures.
export function TrimmedLength(minimum: number, maximum: number) {
  return ValidateBy(
    {
      name: 'trimmedLength',
      constraints: [minimum, maximum],
      validator: {
        defaultMessage: () => '입력값을 확인해 주세요',
        validate(value: unknown) {
          if (typeof value !== 'string') return true;
          const length = value.trim().length;
          return length >= minimum && length <= maximum;
        },
      },
    },
    { context: { omitField: true } },
  );
}
