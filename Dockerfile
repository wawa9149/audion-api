# 1. Node 기반 이미지
FROM node:18-alpine

# 2. 작업 디렉토리 생성
WORKDIR /app

# 3. package.json 및 lock 파일 복사
COPY package*.json ./

# 4. 의존성 설치
RUN npm install

# 5. 나머지 소스 복사
COPY . .

# 6. 빌드
RUN npm run build

# 7. 포트 열기
EXPOSE 3000

# 8. 앱 실행
CMD ["node", "dist/main"]
