const TELEGRAPH_URL = 'https://api.sensenova.cn';

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  const url = new URL(request.url);
  const headers_Origin = request.headers.get("Access-Control-Allow-Origin") || "*"
  
  if (url.pathname === '/v1/chat/completions') {
    url.host = TELEGRAPH_URL.replace(/^https?:\/\//, '');
    url.pathname = '/v1/llm/chat-completions';
    
    const modifiedBody = await modifyRequestBody(request);
    const modifiedHeaders = new Headers(request.headers);
    
    // 处理Authorization头
    const authorizationHeader = request.headers.get('Authorization');
    if (authorizationHeader) {
      const [_, aksk] = authorizationHeader.split(' ');
      if (aksk.includes('|')) {
        // 使用ak和sk生成API_Token
        const [ak, sk] = aksk.split('|');
        const api_token = await encodeJWTToken(ak, sk);
        console.log(api_token);
        modifiedHeaders.set('Authorization', `Bearer ${api_token}`);
      } else {
        // 使用自行生成的API_Token
        modifiedHeaders.set('Authorization', authorizationHeader);
      }
    }

    const modifiedRequest = new Request(url.toString(), {
      headers: modifiedHeaders,
      method: request.method,
      body: modifiedBody,
      redirect: 'follow'
    });  
    
    const response = await fetch(modifiedRequest);
    // 判断是否为 SSE 请求
    if (response.headers.get('Content-Type') === 'text/event-stream') {
      // 如果是 SSE 请求,则对结果进行修改和映射
      const transformedStream = new TransformStream({
        transform(chunk, controller) {
          const transformedChunk = transformSSEChunk(chunk, request);
          controller.enqueue(transformedChunk);
        }
      });
      
      // stream=false直接转发
      return new Response(response.body.pipeThrough(transformedStream), {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': headers_Origin
        }
      });
    }
    
    const modifiedResponse = new Response(response.body, response);
    modifiedResponse.headers.set('Access-Control-Allow-Origin', headers_Origin);
    return modifiedResponse;
  }
  
  // 对于其他请求,直接转发
  const modifiedRequest = new Request(request);
  const response = await fetch(modifiedRequest);
  const modifiedResponse = new Response(response.body, response);
  modifiedResponse.headers.set('Access-Control-Allow-Origin', headers_Origin);
  return modifiedResponse;
}

async function modifyRequestBody(request) {
  const contentType = request.headers.get('Content-Type');
  if (contentType && contentType.includes('application/json')) {
    const body = await request.json();
    if (body.hasOwnProperty('max_tokens')) {
      body.max_new_tokens = body.max_tokens;
      delete body.max_tokens;
    }
    if (body.hasOwnProperty('frequency_penalty')) {
      const frequencyPenalty = body.frequency_penalty;
      body.repetition_penalty = (frequencyPenalty + 2) / 2;
      delete body.frequency_penalty;
    }
    if (body.hasOwnProperty('top_p')) {
      const topP = body.top_p;
      body.top_p = topP <= 0 ? 0.000001 : (topP >= 1 ? 0.999999 : topP);
    }
    return JSON.stringify(body);
  }
  return request.body;
}

let buffer = '';

function transformSSEChunk(chunk, originalRequest) {
  if (!(chunk instanceof Uint8Array)) {
    chunk = new Uint8Array(chunk);
  }
  const chunkStr = new TextDecoder().decode(chunk);
  buffer += chunkStr;

  let result = '';
  let position = 0;

  // 获取原始请求体中的model字段
  const originalBody = originalRequest.json();
  const originalModel = originalBody.model;

  while (position < buffer.length) {
    const nextPosition = buffer.indexOf('\n\n', position);

    if (nextPosition !== -1) {
      const eventStr = buffer.slice(position, nextPosition).trim();

      if (eventStr.startsWith('data:')) {
        const dataStr = eventStr.slice(5).trim();

        if (dataStr === '[DONE]') {
          result += 'data: [DONE]\n\n';
        } else {
          let data;

          try {
            data = JSON.parse(dataStr);
          } catch (error) {
            console.error('Error parsing JSON:', error);
            position = nextPosition + 2;
            continue;
          }

          const transformedData = {
            id: data.data.id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: originalModel, // 使用原始请求体中的model字段
            system_fingerprint: 'cf-openai-sensechat-proxy-123',
            choices: data.data.choices.map(choice => ({
              index: choice.index,
              delta: transformDelta(choice.delta, choice.role),
              logprobs: null,
              finish_reason: choice.finish_reason === '' ? null : choice.finish_reason
            }))
          };

          result += `data: ${JSON.stringify(transformedData)}\n\n`;
        }
      } else {
        result += eventStr + '\n\n';
      }

      position = nextPosition + 2;
    } else {
      break;
    }
  }

  buffer = buffer.slice(position);
  return new TextEncoder().encode(result);
}

function transformDelta(delta, role) {
  if (typeof delta === 'string') {
    return {
      role: role,
      content: delta
    };
  } else if (Object.keys(delta).length === 0) {
    return {};
  } else {
    return {
      content: delta
    };
  }
}

async function encodeJWTToken(ak, sk) {
  const headers = {
    "alg": "HS256",
    "typ": "JWT"
  };

  const payload = {
    "iss": ak,
    "exp": Math.floor(Date.now() / 1000) + 120, // 当前时间+120秒
    "nbf": Math.floor(Date.now() / 1000) - 5
  };

  const encoder = new TextEncoder();
  const secretKeyData = encoder.encode(sk);

  const unsignedToken = base64UrlEncode(JSON.stringify(headers)) + '.' + base64UrlEncode(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    "raw",
    secretKeyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(unsignedToken));
  const signatureBase64 = base64UrlEncode(String.fromCharCode.apply(null, new Uint8Array(signature)));

  const apiToken = unsignedToken + '.' + signatureBase64;
  return apiToken;
}

function base64UrlEncode(str) {
  return btoa(str)
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
