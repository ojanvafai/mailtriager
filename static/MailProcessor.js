import { ErrorLogger } from './ErrorLogger.js';
import { fetchThread, fetchThreads } from './main.js';
import { Labels } from './Labels.js';
import { QueueSettings } from './QueueSettings.js';
import { ServerStorage } from './ServerStorage.js';
import { SpreadsheetUtils } from './SpreadsheetUtils.js';

const STATISTICS_SHEET_NAME = 'statistics';
const DAILY_STATS_SHEET_NAME = 'daily_stats';

export class MailProcessor {
  constructor(settings, pushThread, queuedLabelMap, allLabels, updateTitle) {
    this.settings = settings;
    this.pushThreadOriginal_ = pushThread;
    this.queuedLabelMap_ = queuedLabelMap;
    this.allLabels_ = allLabels;
    this.updateTitle_ = updateTitle;
  }

  async pushThread_(thread) {
    let newThread = await fetchThread(thread.id);
    await this.pushThreadOriginal_(newThread);
  }

  endsWithAddress(addresses, filterAddress) {
    for (var j = 0; j < addresses.length; j++) {
      if (addresses[j].endsWith(filterAddress))
        return true;
    }
    return false;
  }

  matchesRegexp(regex, str) {
    return (new RegExp(regex, 'm')).test(str);
  }

  // This is to avoid triggering regexps accidentally on plain test things
  // being run through this.matchesRegexp
  escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  startsWithAddress(addresses, filterAddress) {
    var parts = this.escapeRegExp(filterAddress).split('@');
    var regexp = '^' + parts[0] + '(?:\\+[^@]*?)?@' + parts[1];
    for (var j = 0; j < addresses.length; j++) {
      if (this.matchesRegexp(regexp, addresses[j]))
        return true;
    }
    return false;
  }

  containsAddress(addresses, filterAddressCsv) {
    if (!addresses)
      return false;

    var filterAddresses = filterAddressCsv.split(',');
    for (var i = 0; i < filterAddresses.length; i++) {
      var filterAddress = filterAddresses[i];
      // If there's no @ symbol, we don't know if it's a username or a domain.
      // Try both.
      if (filterAddress.includes("@")) {
        if (this.startsWithAddress(addresses, filterAddress))
          return true;
      } else {
        if (this.startsWithAddress(addresses, filterAddress + "@"))
          return true;
        if (this.endsWithAddress(addresses, "@" + filterAddress))
          return true;
      }
    }
    return false;
  }

  async writeToStatsPage(timestamp, num_threads_processed, per_label_counts, time_taken) {
    var data = [timestamp, num_threads_processed, time_taken, JSON.stringify(per_label_counts)];
    await SpreadsheetUtils.appendToSheet(this.settings.spreadsheetId, STATISTICS_SHEET_NAME, [data]);
  }

  getYearMonthDay(timestamp) {
    let date = new Date(timestamp);

    let month = date.getMonth() + 1;
    if (month < 10)
      month = '0' + month;

    let day = date.getDate();
    if (day < 10)
      day = '0' + day;

    return date.getFullYear() + '/' + month + '/' + day;
  }

  async writeCollapsedStats(stats) {
    if (stats && stats.numInvocations)
      await SpreadsheetUtils.appendToSheet(this.settings.spreadsheetId, DAILY_STATS_SHEET_NAME, [Object.values(stats)]);
  }

  async collapseStats() {
    this.updateTitle_('collapseStats', 'Writing stats...');

    let stats;
    var rows = await SpreadsheetUtils.fetchSheet(this.settings.spreadsheetId, STATISTICS_SHEET_NAME);
    let todayYearMonthDay = this.getYearMonthDay(Date.now());
    let currentYearMonthDay;

    let lastRowProcessed = 0;

    for (var i = 1; i < rows.length; ++i) {
      // timestamp, threads_processed, messages_processed, total_time, perLabelThreadCountJSON

      let timestamp = Number(rows[i][0]);
      // Ignore empty rows
      if (!timestamp) {
        continue;
      }

      let yearMonthDay = this.getYearMonthDay(timestamp);

      if (todayYearMonthDay < yearMonthDay)
        throw `Something is wrong with the statistics spreadsheet. Some rows have dates in the future: ${yearMonthDay}`;

      // Don't process any rows from today. Since the sheet is in date order, we can stop processing entirely.
      if (todayYearMonthDay == yearMonthDay)
        break;

      if (currentYearMonthDay != yearMonthDay) {
        await this.writeCollapsedStats(stats);
        currentYearMonthDay = yearMonthDay;
        stats = {
          yearMonthDay: currentYearMonthDay,
          totalThreads: 0,
          ignoredThreads: 0,
          nonIgnoredThreads: 0,
          immediateCount: 0,
          dailyCount: 0,
          weeklyCount: 0,
          monthlyCount: 0,
          numInvocations: 0,
          totalTime: 0,
          minTime: Number.MAX_VALUE,
          maxTime: 0,
        };
      }

      lastRowProcessed = i;

      stats.numInvocations++;
      stats.totalThreads += Number(rows[i][1]);

      stats.totalTime += Number(rows[i][2]);
      stats.minTime = Math.min(stats.minTime, Number(rows[i][2]));
      stats.maxTime = Math.max(stats.maxTime, Number(rows[i][2]));

      var labelCounts = JSON.parse(rows[i][3]);
      for (var label in labelCounts) {
        var count = labelCounts[label];
        if (label == Labels.ARCHIVE_LABEL) {
          stats.ignoredThreads += count;
        } else {
          stats.nonIgnoredThreads += count;

          let queueData = this.queuedLabelMap_.get(label);
          if (queueData.queue == QueueSettings.IMMEDIATE) {
            stats.immediateCount += count;
          } else if (queueData.queue == QueueSettings.DAILY) {
            stats.dailyCount += count;
          } else if (queueData.queue == QueueSettings.MONTHLY) {
            stats.monthlyCount += count;
          } else {
            // Assume all the other queues are weekly queues.
            stats.weeklyCount += count;
          }
        }
      }
    }

    await this.writeCollapsedStats(stats);

    if (lastRowProcessed)
      await SpreadsheetUtils.deleteRows(this.settings.spreadsheetId, STATISTICS_SHEET_NAME, 1, lastRowProcessed + 1);

    this.updateTitle_('collapseStats');
  }

  matchesHeader_(message, header) {
    let colonIndex = header.indexOf(':');
    if (colonIndex == -1) {
      ErrorLogger.log(`Invalid header filter. Header filters must be of the form headername:filtervalue.`);
      return false;
    }
    let name = header.substring(0, colonIndex).trim();
    let value = header.substring(colonIndex + 1).toLowerCase().trim();
    let headerValue = message.getHeaderValue(name);
    return headerValue && headerValue.toLowerCase().trim().includes(value);
  }

  matchesRule(rule, message) {
    var matches = false;
    if (rule.nolistid) {
      if (message.listId)
        return false;
      matches = true;
    }
    if (rule.to) {
      if (!this.containsAddress(message.toEmails, rule.to) &&
          !this.containsAddress(message.ccEmails, rule.to) &&
        !this.containsAddress(message.bccEmails, rule.to))
        return false;
      matches = true;
    }
    if (rule.from) {
      if (!this.containsAddress(message.fromEmails, rule.from))
        return false;
      matches = true;
    }
    if (rule.header) {
      if (!this.matchesHeader_(message, rule.header))
        return false;
      matches = true;
    }
    // TODO: only need to do this once per thread.
    if (rule.subject) {
      if (!message.subject || !message.subject.toLowerCase().includes(rule.subject))
        return false;
      matches = true;
    }
    if (rule.plaintext) {
      if (!message.getPlain().toLowerCase().includes(rule.plaintext))
        return false;
      matches = true;
    }
    if (rule.htmlcontent) {
      if (!message.getHtmlOrPlain().toLowerCase().includes(rule.htmlcontent))
        return false;
      matches = true;
    }
    return matches;
  }

  async processThread(thread, rules) {
    var messages = await thread.getMessages();

    for (let rule of rules) {
      if (rule.matchallmessages == 'yes') {
        let matches = false;
        for (let message of messages) {
          matches = this.matchesRule(rule, message);
          if (!matches)
            break;
        }
        if (matches)
          return rule.label;
      } else {
        for (let message of messages) {
          if (this.matchesRule(rule, message))
            return rule.label;
        }
      }
    }

    // Ensure there's always some label to make sure bugs don't cause emails to get lost silently.
    return Labels.FALLBACK_LABEL;
  }

  async currentTriagedLabel(thread) {
    var labels = await thread.getLabelNames();
    for (let label of labels) {
      if (Labels.isTriagedLabel(label))
        return label;
    }
    return null;
  }

  async processMail() {
    let threads = [];
    await fetchThreads(thread => threads.push(thread), {
      query: `in:${Labels.UNPROCESSED_LABEL}`,
    });

    if (!threads.length)
      return;

    let startTime = new Date();
    let rulesSheet = await this.settings.getFilters();

    let newlyLabeledThreadsCount = 0;
    let perLabelCounts = {};

    for (var i = 0; i < threads.length; i++) {
      try {
        this.updateTitle_('processMail', `Processing ${i + 1}/${threads.length} unprocessed threads...`);

        let thread = threads[i];
        let labelName;

        let removeLabelIds = this.allLabels_.getMakeTimeLabelIds().concat();
        let addLabelIds = [];

        let currentTriagedLabel = await this.currentTriagedLabel(thread);
        if (currentTriagedLabel == Labels.MUTED_LABEL) {
          await thread.modify(addLabelIds, removeLabelIds);
          continue;
        } else {
          labelName = await this.processThread(thread, rulesSheet.rules);
        }

        let alreadyHadLabel = false;
        let isAlreadyInInbox = thread.isInInbox();

        if (labelName == Labels.ARCHIVE_LABEL) {
          addLabelIds.push(await this.allLabels_.getId(Labels.PROCESSED_ARCHIVE_LABEL));
          removeLabelIds.push('INBOX');
        } else {
          let prefixedLabelName;

          // Don't queue if already in the inbox or triaged.
          if (isAlreadyInInbox || currentTriagedLabel || this.queuedLabelMap_.get(labelName).queue == QueueSettings.IMMEDIATE) {
            prefixedLabelName = Labels.needsTriageLabel(labelName);
          } else {
            prefixedLabelName = Labels.addQueuedPrefix(labelName);
          }

          let prefixedLabelId = await this.allLabels_.getId(prefixedLabelName);

          let labelIds = await thread.getLabelIds();
          alreadyHadLabel = labelIds.has(prefixedLabelId);

          addLabelIds.push(prefixedLabelId);
          removeLabelIds = removeLabelIds.filter(id => id != prefixedLabelId);

          if (prefixedLabelName != Labels.addQueuedPrefix(labelName))
            addLabelIds.push('INBOX');
        }

        await thread.modify(addLabelIds, removeLabelIds);
        // TODO: If isAlreadyInInbox && !alreadyHadLabel, we should remove it from the threadlist
        // and add it back in so it gets put into the right queue.
        if (!isAlreadyInInbox && addLabelIds.includes('INBOX'))
          await this.pushThread_(thread);

        if (!alreadyHadLabel) {
          if (!perLabelCounts[labelName])
            perLabelCounts[labelName] = 0;
          perLabelCounts[labelName] += 1;
          newlyLabeledThreadsCount++;
        }
      } catch (e) {
        ErrorLogger.log(`Failed to process message. Left it in the unprocessed label.\n\n${JSON.stringify(e)}`);
      }
    }

    if (newlyLabeledThreadsCount) {
      this.writeToStatsPage(
        startTime.getTime(), newlyLabeledThreadsCount, perLabelCounts, Date.now() - startTime.getTime());
    }

    this.updateTitle_('processMail');
    return threads.length;
  }

  async dequeue(labelName, queue) {
    var queuedLabelName = Labels.addQueuedPrefix(labelName);
    var queuedLabel = await this.allLabels_.getId(queuedLabelName);
    var autoLabel = await this.allLabels_.getId(Labels.needsTriageLabel(labelName));

    let threads = [];
    await fetchThreads(thread => threads.push(thread), {
      query: `in:${queuedLabelName}`,
    });

    if (!threads.length)
      return;

    for (var i = 0; i < threads.length; i++) {
      this.updateTitle_('dequeue', `Dequeuing ${i + 1}/${threads.length} from ${labelName}...`);

      var thread = threads[i];
      let addLabelIds = ['INBOX', autoLabel];
      let removeLabelIds = [queuedLabel];
      await thread.modify(addLabelIds, removeLabelIds);
      await this.pushThread_(thread);
    }
    this.updateTitle_('dequeue');
  }

  async processSingleQueue(queue) {
    let queueDatas = this.queuedLabelMap_.entries();
    for (let queueData of queueDatas) {
      if (queueData[1].queue == queue)
        await this.dequeue(queueData[0], queue);
    }
  }

  categoriesToDequeue(startTime, opt_endTime) {
    if (!startTime) {
      let today = QueueSettings.WEEKDAYS[new Date().getDay()];
      return [today, QueueSettings.DAILY];
    }

    let start = Number(startTime);
    let end = opt_endTime || Date.now();

    var oneDay = 24 * 60 * 60 * 1000;
    var diffDays = (end - start) / (oneDay);

    if (diffDays >= 30)
      return QueueSettings.WEEKDAYS.concat([QueueSettings.DAILY, QueueSettings.MONTHLY]);
    if (diffDays >= 7)
      return QueueSettings.WEEKDAYS.concat([QueueSettings.DAILY]);

    let startDate = new Date(start);
    let endDate = new Date(end);
    let startDay = startDate.getDay();
    let endDay = endDate.getDay();

    // Have already processed today.
    if (startDay == endDay && diffDays < 1)
      return [];

    let days = [];

    while (true) {
      var modded = ++startDay % QueueSettings.WEEKDAYS.length;
      days.push(QueueSettings.WEEKDAYS[modded]);
      if (modded == endDay)
        break;
    }

    days.push(QueueSettings.DAILY);

    if (startDate.getMonth() < endDate.getMonth())
      days.push(QueueSettings.MONTHLY);

    return days;
  }

  async processQueues() {
    let storage = new ServerStorage(this.settings.spreadsheetId);
    await storage.fetch();
    let lastDequeueTime = storage.get(ServerStorage.KEYS.LAST_DEQUEUE_TIME);
    const categories = this.categoriesToDequeue(lastDequeueTime);

    if (!categories.length)
      return;

    for (const category of categories) {
      await this.processSingleQueue(category);
    }

    await storage.writeUpdates([{key: ServerStorage.KEYS.LAST_DEQUEUE_TIME, value: Date.now()}]);
  }
}

