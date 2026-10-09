import { Injectable } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';

@Injectable()
export class OpenApiService {
  private document?: OpenAPIObject;

  configure(document: OpenAPIObject) {
    // Swagger metadata may contain reused nested objects. Own the complete JSON
    // document so creating or closing another Nest app cannot change this one.
    this.document = structuredClone(document);
  }

  getDocument() {
    if (!this.document) throw new Error('OpenAPI document is not configured');
    return this.document;
  }
}
