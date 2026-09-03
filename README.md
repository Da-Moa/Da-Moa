# 다모아

영수증을 추가하고 총 결제 금액과 인원을 입력해 모임 비용을 간편하게 나누는 웹 앱입니다.

## 현재 구현

- 영수증 이미지 촬영 또는 파일 선택
- 총 결제 금액과 인원 수 입력
- 1원 단위까지 공정한 균등 분할
- 정산 링크 만들기 버튼의 다음 단계 안내

영수증 OCR과 실제 정산 링크·송금 연동은 아직 구현되지 않았습니다. 현재는 영수증 파일명만 표시하고 금액을 직접 입력합니다.

## 실행

```bash
npm install
npm run dev
```

브라우저에서 [http://localhost:3000](http://localhost:3000)을 엽니다.

## 확인

```bash
npm test
npm run build
```

## 기술

- Next.js
- React
- TypeScript
