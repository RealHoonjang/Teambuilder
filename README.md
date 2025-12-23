# 체육 팀 편성 프로그램 (순수 HTML/JS/CSS 버전)

React 없이 순수 HTML, JavaScript, CSS로 구현된 체육 팀 편성 프로그램입니다.

## 파일 구조

```
standalone/
├── index.html    # 메인 HTML 파일
├── app.js        # 모든 JavaScript 로직
├── style.css     # 스타일 파일
└── README.md     # 이 파일
```

## 사용 방법

1. **로컬에서 실행**
   - `index.html` 파일을 브라우저로 직접 열기
   - 또는 로컬 웹 서버 사용:
     ```bash
     # Python 3
     python -m http.server 8000
     
     # Node.js (http-server 설치 필요)
     npx http-server
     ```

2. **GitHub Pages에 배포**
   - `standalone` 폴더의 모든 파일을 GitHub 리포지토리에 업로드
   - GitHub Pages 설정에서 루트 폴더 선택
   - 배포 완료!

## 주요 기능

- ✅ 엑셀 파일 업로드 (드래그 앤 드롭 지원)
- ✅ 랜덤 팀 편성 (균등한 인원 분배)
- ✅ 밸런스 팀 편성 (기록 기반 균형)
- ✅ 수동 팀 편성 (교사가 직접 조정)
- ✅ 학생용 인터페이스 (이름 숨김, 데이터만 표시)
- ✅ 팀 편성 확인 기능

## 의존성

- **Tailwind CSS**: CDN으로 로드 (스타일링)
- **SheetJS (xlsx)**: CDN으로 로드 (엑셀 파일 파싱)

모든 의존성이 CDN으로 제공되므로 별도 설치가 필요 없습니다.

## 엑셀 파일 형식

- 첫 번째 줄(행)에 항목 이름을 적어주세요 (예: 이름, 기록1, 기록2 등)
- 이름 열에는 "이름"이라는 단어가 포함되어야 합니다
- 숫자 기록은 이름 열을 제외한 다른 열에 입력하세요

## 브라우저 호환성

모든 최신 브라우저에서 작동합니다:
- Chrome/Edge (권장)
- Firefox
- Safari

## React 버전과의 차이점

- React 없이 순수 JavaScript로 구현
- 빌드 과정 불필요 (바로 사용 가능)
- GitHub Pages 배포가 더 간단
- 모든 기능 동일하게 작동

