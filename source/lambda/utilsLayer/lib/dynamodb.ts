// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DynamoDBClient, DynamoDBServiceException } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  GetCommand,
  BatchWriteCommand,
  BatchWriteCommandOutput,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { catchDecorator } from "./catch";
import { ServiceHelper, sleep } from "./exports";
import { logger } from "./logger";
import { ScanCommandOutput } from "@aws-sdk/lib-dynamodb/dist-types/commands/ScanCommand";

/**
 * @description helper class for Event Bridge
 */
export class DynamoDBHelper extends ServiceHelper<DynamoDBClient> {
  readonly client;
  /**
   * @description module name to be used in logging
   */
  protected readonly moduleName: string;
  /**
   * @description ddb doc client to work with JSON
   */
  readonly ddbDocClient;
  constructor() {
    super();
    this.client = new DynamoDBClient({
      customUserAgent: process.env.CUSTOM_SDK_USER_AGENT,
    });
    this.moduleName = <string>__filename.split("/").pop();
    this.ddbDocClient = DynamoDBDocumentClient.from(this.client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  /**
   * @description put command using ddb document client
   * @param tableName
   * @param item JSON item to put on the table
   */
  @catchDecorator(DynamoDBServiceException, true)
  async putItem(tableName: string, item: Record<string, any>) {
    logger.debug({
      label: this.moduleName,
      message: `putting JSON item on ${tableName}: ${JSON.stringify(item)}`,
    });
    await this.ddbDocClient.send(new PutCommand({ TableName: tableName, Item: item }));
  }

  /**
   * @description Executes a BatchWrite command using DynamoDB document client with retries
   * @param tableName
   * @param writeRequests An array of write requests (PutRequest or DeleteRequest)
   */
  @catchDecorator(DynamoDBServiceException, true)
  async batchWrite(
    tableName: string,
    writeRequests: any[]
  ): Promise<{ success: boolean; result: BatchWriteCommandOutput }> {
    const maxRetries = 5;
    let retries = 0;
    let result: BatchWriteCommandOutput;
    do {
      const params = {
        RequestItems: {
          [tableName]: writeRequests,
        },
      };
      result = await this.ddbDocClient.send(new BatchWriteCommand(params));
      writeRequests = result.UnprocessedItems?.[tableName] || [];
      if (writeRequests.length === 0) {
        return { success: true, result }; // All items processed successfully
      }
      retries++;
      if (retries < maxRetries) {
        await sleep(2 ** retries * 1000 + 1000); // Exponential backoff
      }
    } while (retries < maxRetries);
    logger.warn({
      label: this.moduleName,
      message: `Failed to process ${writeRequests.length} items after ${maxRetries} attempts.`,
    });
    return { success: false, result };
  }

  /**
   * @descrition get item from table
   * @param tableName
   * @param key
   * @returns
   */
  @catchDecorator(DynamoDBServiceException, false)
  async getItem(tableName: string, key: { [_: string]: string }) {
    logger.debug({
      label: this.moduleName,
      message: `getting item from ${tableName} for ${JSON.stringify(key)}`,
    });
    const response = await this.ddbDocClient.send(
      new GetCommand({
        TableName: tableName,
        Key: key,
      })
    );
    logger.debug({
      label: this.moduleName,
      message: `get item response: ${JSON.stringify(response)}`,
    });
    return response.Item;
  }

  /**
   * @description query items using ddb document client for given service code
   * @param tableName - quota table name
   * @param serviceCode - service code for which to fetch quotas
   * @returns
   */
  @catchDecorator(DynamoDBServiceException, false)
  async queryQuotasForService(tableName: string, serviceCode: string) {
    logger.debug({
      label: this.moduleName,
      message: `getting quota items from ${tableName} for ${serviceCode}`,
    });
    const response = await this.ddbDocClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "ServiceCode = :value",
        ExpressionAttributeValues: {
          ":value": serviceCode,
        },
      })
    );
    return response.Items;
  }

  /**
   * @description deletes multiple quotas for a service from ddb
   * @param tableName
   * @param deleteRequests
   */
  @catchDecorator(DynamoDBServiceException, false)
  async batchDelete(tableName: string, deleteRequests: Record<string, any>[]) {
    logger.debug({
      label: this.moduleName,
      message: `deleting quotas`,
    });

    if (deleteRequests.length === 0) return;
    const batchWriteParams = {
      RequestItems: {
        [tableName]: deleteRequests,
      },
    };
    await this.ddbDocClient.send(new BatchWriteCommand(batchWriteParams));
  }

  /**
   * @description retrieves enabled service codes using ddb document client
   * @param tableName - service table name
   * @returns
   */
  @catchDecorator(DynamoDBServiceException, true)
  async getAllEnabledServices(tableName: string): Promise<string[]> {
    logger.debug({
      label: this.moduleName,
      message: `getting services from from ${tableName}`,
    });
    let response: ScanCommandOutput | undefined = undefined;
    const allItems: string[] = [];
    do {
      response = await this.ddbDocClient.send(
        new ScanCommand({
          TableName: tableName,
          ExclusiveStartKey: response ? response.LastEvaluatedKey : undefined,
        })
      );
      if (response.Items) {
        allItems.push(
          ...response.Items.filter((item) => item["Monitored"] === true).map((item) => item["ServiceCode"])
        );
      }
    } while (response.LastEvaluatedKey);
    return allItems;
  }
}
