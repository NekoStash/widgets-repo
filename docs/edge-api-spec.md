# Edge API

## Endpoints

### `GET /search?q=music`

```json
{
  "ok": true,
  "query": "music",
  "tokens": ["music"],
  "total": 1,
  "items": [
    {
      "id": "music",
      "name": "音乐歌词",
      "description": "A music player compatible with the Xiaomi RearScreen series. 适用于小米背屏系列的音乐播放器。",
      "author": {
        "login": "SiberiaApp",
        "name": "SiberiaApp",
        "url": "https://github.com/SiberiaApp",
        "avatarUrl": "https://avatars.githubusercontent.com/u/64341099?v=4",
        "type": "User"
      }
    }
  ]
}
```

### `GET /recent-updates`

```json
{
  "version": 1,
  "limit": 20,
  "items": [
    {
      "id": "music",
      "name": "音乐歌词",
      "description": "A music player compatible with the Xiaomi RearScreen series. 适用于小米背屏系列的音乐播放器。",
      "author": {
        "login": "SiberiaApp",
        "name": "SiberiaApp",
        "url": "https://github.com/SiberiaApp",
        "avatarUrl": "https://avatars.githubusercontent.com/u/64341099?v=4",
        "type": "User"
      },
      "updatedAt": "2026-04-07T00:48:48.000Z",
      "repository": {
        "fullName": "SiberiaApp/Xiaomi-RearScreen-Music",
        "url": "https://github.com/SiberiaApp/Xiaomi-RearScreen-Music"
      }
    }
  ]
}
```

### `GET /widget/{id}/description`

```json
{
  "id": "music",
  "name": "音乐歌词",
  "repository": {
    "widgetName": "音乐歌词",
    "owner": "SiberiaApp",
    "name": "Xiaomi-RearScreen-Music",
    "fullName": "SiberiaApp/Xiaomi-RearScreen-Music",
    "url": "https://github.com/SiberiaApp/Xiaomi-RearScreen-Music",
    "description": "A music player compatible with the Xiaomi RearScreen series. 适用于小米背屏系列的音乐播放器。",
    "homepage": "",
    "defaultBranch": "main",
    "language": null,
    "topics": [],
    "stargazersCount": 2,
    "watchersCount": 0,
    "forksCount": 1,
    "openIssuesCount": 0,
    "createdAt": "2026-03-18T05:50:46Z",
    "updatedAt": "2026-04-07T00:48:52Z",
    "pushedAt": "2026-04-07T00:48:48Z"
  }
}
```

### `GET /widget/{id}/author`

```json
{
  "id": "music",
  "author": {
    "login": "SiberiaApp",
    "name": "SiberiaApp",
    "url": "https://github.com/SiberiaApp",
    "avatarUrl": "https://avatars.githubusercontent.com/u/64341099?v=4",
    "type": "User"
  }
}
```

### `GET /widget/{id}/readme`

```json
{
  "id": "music",
  "readme": {
    "name": "README.md",
    "path": "README.md",
    "sha": "abc123",
    "size": 2048,
    "htmlUrl": "https://github.com/SiberiaApp/Xiaomi-RearScreen-Music/blob/main/README.md",
    "downloadUrl": "https://raw.githubusercontent.com/SiberiaApp/Xiaomi-RearScreen-Music/main/README.md",
    "content": "# 音乐歌词\n\n这是组件说明..."
  }
}
```

### `GET /widget/{id}/releases`

```json
{
  "id": "music",
  "releases": [
    {
      "id": 123456,
      "tagName": "v1.0.0",
      "name": "v1.0.0",
      "isDraft": false,
      "isPrerelease": false,
      "createdAt": "2026-04-01T10:00:00Z",
      "publishedAt": "2026-04-01T10:10:00Z",
      "url": "https://github.com/SiberiaApp/Xiaomi-RearScreen-Music/releases/tag/v1.0.0",
      "body": "初始发布版本",
      "assets": [
        {
          "id": 987654,
          "name": "music-v1.0.0.mrc",
          "label": null,
          "size": 524288,
          "contentType": "application/octet-stream",
          "downloadCount": 42,
          "createdAt": "2026-04-01T10:05:00Z",
          "updatedAt": "2026-04-01T10:05:00Z",
          "downloadUrl": "https://github.com/SiberiaApp/Xiaomi-RearScreen-Music/releases/download/v1.0.0/music-v1.0.0.mrc"
        }
      ]
    }
  ]
}
```

### `GET /widget/{id}/releases/{version}/{file}`

```txt
GET /widget/music/releases/v1.0.0/music-v1.0.0.mrc
```

### `GET /`

```json
{
  "msg": "REAREye RearStore Endpoint"
}
```
