# 보안 정책 / Security policy

보안 취약점을 발견하셨다면 **공개 이슈 대신** 이 레포의 **Security → Report a vulnerability**(비공개 취약점 신고)로 알려 주세요. 확인 후 답변드리고, 고친 버전을 릴리스하면서 함께 안내합니다.

If you find a security issue, please **do not open a public issue**. Use **Security → Report a vulnerability** in this repository to report it privately. We will reply after checking and announce the fix with a release.

이 레포는 CLI·라이브러리이며 네트워크 포트를 열지 않습니다. 내부적으로 쓰는 Playwright 브라우저 서버는 localhost 에만 바인딩됩니다. 검사 대상 페이지의 스크립트는 헤드리스 브라우저 안에서 실행되므로, 신뢰하지 않는 URL·HTML 은 격리된 환경에서 검사하세요. / This is a CLI and library; it opens no network port. The Playwright browser server it uses binds to localhost only. Scripts of the inspected page run inside the headless browser, so inspect untrusted URLs or HTML in an isolated environment.
