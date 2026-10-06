# Presentation UI subset

현재 Freesentation 원본의 글자·굵기·폭을 유지한 UI 서브셋이다. 앱 소스에 있는 지원 글자와 ASCII를 먼저 내려받고, 다른 사용자 입력 글자는 `globals.css`의 기존 `Presentation` 폰트로 표시한다. 사용자 입력 문자 범위를 제한하지 않는다.

`next/font/local`이 파일 이름 해시와 장기 캐시를 제공한다. `preload: false`로 현재 화면에 쓰는 굵기만 요청한다. 초기 생성 결과는 굵기별 약 31KB, 지원 글자 543개이며 원본은 굵기별 약 250KB다.

글꼴 변경이나 앱 문구 추가 후, fontTools와 WOFF2 지원이 설치된 개발 환경에서 `python3 scripts/subset-fonts.py`로 다시 생성한다. 일반 npm 설치·빌드·실행에서는 Python이나 다운로드가 필요하지 않다. 생성 스크립트가 글자 보존과 원본 glyph metrics를 확인한다.

원본: `https://cdn.jsdelivr.net/gh/projectnoonnu/2404@1.0/Freesentation-{1..9}{style}.woff2`. [Freesentation 공식 저장소](https://github.com/Freesentation/freesentation)의 SIL Open Font License 1.1은 [OFL.txt](OFL.txt)에 포함했다.
