import { AnyProcedure, TRPCError } from '@trpc/server';
import {
  NodeHTTPHandlerOptions,
  NodeHTTPRequest,
  NodeHTTPResponse,
} from '@trpc/server/dist/adapters/node-http';
import cloneDeep from 'lodash.clonedeep';
import { ZodError, z } from 'zod';

import { generateOpenApiDocument } from '../../generator';
import {
  OpenApiErrorResponse,
  OpenApiMethod,
  OpenApiResponse,
  OpenApiRouter,
  OpenApiSuccessResponse,
} from '../../types';
import { acceptsRequestBody } from '../../utils/method';
import { normalizePath } from '../../utils/path';
import { getInputOutputParsers } from '../../utils/procedure';
import {
  instanceofZodTypeCoercible,
  instanceofZodTypeLikeVoid,
  instanceofZodTypeObject,
  unwrapZodType,
  zodSupportsCoerce,
} from '../../utils/zod';
import { TRPC_ERROR_CODE_HTTP_STATUS, getErrorFromUnknown } from './errors';
import { getBody, getQuery } from './input';
import { createProcedureCache } from './procedures';

export type CreateOpenApiNodeHttpHandlerOptions<
  TRouter extends OpenApiRouter,
  TRequest extends NodeHTTPRequest,
  TResponse extends NodeHTTPResponse,
> = Pick<
  NodeHTTPHandlerOptions<TRouter, TRequest, TResponse>,
  'router' | 'createContext' | 'responseMeta' | 'onError' | 'maxBodySize'
>;

export type OpenApiNextFunction = () => void;

export const createOpenApiNodeHttpHandler = <
  TRouter extends OpenApiRouter,
  TRequest extends NodeHTTPRequest,
  TResponse extends NodeHTTPResponse,
>(
  opts: CreateOpenApiNodeHttpHandlerOptions<TRouter, TRequest, TResponse>,
) => {
  const router = cloneDeep(opts.router);

  // Validate router
  if (process.env.NODE_ENV !== 'production') {
    generateOpenApiDocument(router, { title: '', version: '', baseUrl: '' });
  }

  const { createContext, responseMeta, onError, maxBodySize } = opts;
  const getProcedure = createProcedureCache(router);

  return async (req: TRequest, res: TResponse, next?: OpenApiNextFunction) => {
    const sendResponse = (
      statusCode: number,
      headers: Record<string, string>,
      body: OpenApiResponse | undefined,
    ) => {
      res.statusCode = statusCode;

      // Support sending SSE streams
      if (body && typeof body.getReader === 'function') {
        const reader = body.getReader();

        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.flushHeaders();

        const processStream = async (reader: ReadableStreamDefaultReader, res: TResponse) => {
          try {
            let done, value;
            do {
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              ({ done, value } = await reader.read());
              console.log('done', done, 'value', value);
              if (!done) {
                res.write(`data: ${Buffer.from(value.buffer).toString()}\n\n`);
                // @ts-expect-error flush is not in the types
                res.flush();
              }
            } while (!done);
            res.write('data: [DONE]\n\n');
          } catch (error) {
            console.error('Error while reading from stream', error);
          } finally {
            reader.releaseLock();
            res.end();
          }
        };

        void processStream(reader, res);
      } else {
        res.setHeader('Content-Type', 'application/json');
        for (const [key, value] of Object.entries(headers)) {
          if (typeof value !== 'undefined') {
            res.setHeader(key, value);
          }
        }
        res.end(JSON.stringify(body));
      }
    };

    const method = req.method! as OpenApiMethod & 'HEAD';
    const reqUrl = req.url!;
    const url = new URL(reqUrl.startsWith('/') ? `http://127.0.0.1${reqUrl}` : reqUrl);
    const path = normalizePath(url.pathname);
    const { procedure, pathInput } = getProcedure(method, path) ?? {};

    let input: any = undefined;
    let ctx: any = undefined;
    let data: any = undefined;

    try {
      if (!procedure) {
        if (next) {
          return next();
        }

        // Can be used for warmup
        if (method === 'HEAD') {
          sendResponse(204, {}, undefined);
          return;
        }

        throw new TRPCError({
          message: 'Not found',
          code: 'NOT_FOUND',
        });
      }

      const useBody = acceptsRequestBody(method);
      const schema = getInputOutputParsers(procedure.procedure).inputParser as z.ZodTypeAny;
      const unwrappedSchema = unwrapZodType(schema, true);

      // input should stay undefined if z.void()
      if (!instanceofZodTypeLikeVoid(unwrappedSchema)) {
        input = {
          ...(useBody ? await getBody(req, maxBodySize) : getQuery(req, url)),
          ...pathInput,
        };
      }

      // if supported, coerce all string values to correct types
      if (zodSupportsCoerce) {
        if (instanceofZodTypeObject(unwrappedSchema)) {
          Object.values(unwrappedSchema.shape).forEach((shapeSchema) => {
            const unwrappedShapeSchema = unwrapZodType(shapeSchema, false);
            if (instanceofZodTypeCoercible(unwrappedShapeSchema)) {
              unwrappedShapeSchema._def.coerce = true;
            }
          });
        }
      }

      ctx = await createContext?.({ req, res });
      const caller = router.createCaller(ctx);

      const segments = procedure.path.split('.');
      const procedureFn = segments.reduce((acc, curr) => acc[curr], caller as any) as AnyProcedure;

      data = await procedureFn(input);

      const meta = responseMeta?.({
        type: procedure.type,
        paths: [procedure.path],
        ctx,
        data: [data],
        errors: [],
      });

      const statusCode = meta?.status ?? 200;
      const headers = meta?.headers ?? {};
      const body: OpenApiSuccessResponse<typeof data> = data;
      sendResponse(statusCode, headers, body);
    } catch (cause) {
      const error = getErrorFromUnknown(cause);

      onError?.({
        error,
        type: procedure?.type ?? 'unknown',
        path: procedure?.path,
        input,
        ctx,
        req,
      });

      const meta = responseMeta?.({
        type: procedure?.type ?? 'unknown',
        paths: procedure?.path ? [procedure?.path] : undefined,
        ctx,
        data: [data],
        errors: [error],
      });

      const errorShape = router.getErrorShape({
        error,
        type: procedure?.type ?? 'unknown',
        path: procedure?.path,
        input,
        ctx,
      });

      const isInputValidationError =
        error.code === 'BAD_REQUEST' &&
        error.cause instanceof Error &&
        error.cause.name === 'ZodError';

      const statusCode = meta?.status ?? TRPC_ERROR_CODE_HTTP_STATUS[error.code] ?? 500;
      const headers = meta?.headers ?? {};
      const body: OpenApiErrorResponse = {
        message: isInputValidationError
          ? 'Input validation failed'
          : errorShape?.message ?? error.message ?? 'An error occurred',
        code: error.code,
        issues: isInputValidationError ? (error.cause as ZodError).errors : undefined,
      };
      sendResponse(statusCode, headers, body);
    }
  };
};
