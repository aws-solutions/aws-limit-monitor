// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  LambdaTriggers,
  logger,
  ServiceQuotasHelper,
  UnsupportedEventException,
} from "solutions-utils";
import { ServiceQuota } from "@aws-sdk/client-service-quotas";
import {
  createQuotaUtilizationEvents,
  generateCWQueriesForAllQuotas,
  generateMetricQueryIdMap,
  getCWDataForQuotaUtilization,
  getQuotasForService,
  sendQuotaUtilizationEventsToBridge,
} from "./exports";

/**
 * @description executing module name
 */
const MODULE_NAME = __filename.split("/").pop();

/**
 * @description entry point for microservice
 */
export const handler = async (event: any) => {
  logger.debug({
    label: `${MODULE_NAME}/handler`,
    message: JSON.stringify(event),
  });

  if (!LambdaTriggers.isScheduledEvent(event))
    throw new UnsupportedEventException("this event type is not supported");

  const sq = new ServiceQuotasHelper();
  const serviceCodes: string[] = await sq.getServiceCodes();
  logger.debug({
    label: `${MODULE_NAME}/handler/serviceCodes`,
    message: JSON.stringify(serviceCodes),
  });
  await Promise.allSettled(
    serviceCodes.map(async (service) => {
      await handleQuotasForService(service);
    })
  );
  // currently supported number of quotas <500
  // extend this to support more than 500 service quotas
  // single GetMetricData Api supports 500 metrics so multiple GetMetricData fetches will be needed
  // https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_GetMetricData.html
};

async function handleQuotasForService(service: string) {
  const quotaItems = await getQuotasForService(
    <string>process.env.SQ_QUOTA_TABLE,
    service
  );
  if (!quotaItems || quotaItems.length == 0) return; // no quota items found
  const queries = generateCWQueriesForAllQuotas(<ServiceQuota[]>quotaItems);
  const metricQueryIdToQuotaMap = generateMetricQueryIdMap(
    <ServiceQuota[]>quotaItems
  );
  const metrics = await getCWDataForQuotaUtilization(queries);
  await Promise.allSettled(
    metrics.map(async (metric) => {
      const utilizationEvents = createQuotaUtilizationEvents(
        metric,
        metricQueryIdToQuotaMap
      );
      logger.debug({
        label: `${MODULE_NAME}/handler/UtilizationEvents`,
        message: JSON.stringify(utilizationEvents),
      });
      await sendQuotaUtilizationEventsToBridge(
        <string>process.env.SPOKE_EVENT_BUS,
        utilizationEvents
      );
    })
  );
  logger.debug(`${service} utilizationEvents sent to spoke event bridge bus`);
}
