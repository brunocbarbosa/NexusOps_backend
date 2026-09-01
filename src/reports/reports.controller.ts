import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { QueryReportsDto } from './dto/query-reports.dto';
import { TicketReportFiltersDto } from './dto/ticket-report-filters.dto';
import { ReportResponse } from './report-response';
import { PaginatedReports, ReportsService } from './reports.service';

/**
 * No `@Roles()` anywhere: a report is filtered by whoever asked for it, so a
 * `REQUESTER` exporting their own tickets is a legitimate thing to do and the
 * worker is what enforces what "their own" means.
 */
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /**
   * **202, not 201.** The resource that was created is a *request*, not the
   * report — the CSV does not exist yet and may still fail. A 201 would tell a
   * client the thing is ready, and the next thing it would do is download an
   * empty file.
   */
  @HttpCode(HttpStatus.ACCEPTED)
  @Post('tickets')
  request(
    @Body() filters: TicketReportFiltersDto,
    @CurrentUser() requester: AuthenticatedUser,
  ): Promise<ReportResponse> {
    return this.reports.requestTicketReport(filters, requester);
  }

  @Get()
  findAll(
    @Query() query: QueryReportsDto,
    @CurrentUser() requester: AuthenticatedUser,
  ): Promise<PaginatedReports> {
    return this.reports.findAll(query, requester);
  }

  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() requester: AuthenticatedUser,
  ): Promise<ReportResponse> {
    return this.reports.findOne(id, requester);
  }

  /**
   * The only route in the application that does not answer JSON, which is why
   * it reaches for `@Res({ passthrough: true })`: the body is text and the
   * filename belongs in a header.
   *
   * `passthrough` matters — without it Nest steps back and the returned value
   * is never sent, so the request hangs until the client gives up.
   */
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Get(':id/download')
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() requester: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const { filename, content } = await this.reports.download(id, requester);

    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    );

    return content;
  }
}
